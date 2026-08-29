#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""软考中项本地学习系统 —— 后端服务。

必须支持 HTTP Range：否则大体积 mp4 无法拖动进度条与快进。
启动: python3 server.py [port]
"""

import json
import os
import re
import sys
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "study", "web")
DATA_DIR = os.path.join(ROOT, "study", "data")
# 自动适配视频目录：优先新版 "VID"，兼容旧版中文目录名
VIDEO_DIR = os.path.join(ROOT, "VID")
if not os.path.isdir(VIDEO_DIR):
    VIDEO_DIR = os.path.join(ROOT, "软考集成视频以及笔记")
PROGRESS_FILE = os.path.join(DATA_DIR, "progress.json")

# URL 前缀 -> 物理目录
ROUTES = {
    "/video/": VIDEO_DIR,
    "/transcript/": os.path.join(VIDEO_DIR, "transcripts"),
    "/kp/": os.path.join(VIDEO_DIR, "knowledge_points"),
    "/img/": os.path.join(ROOT, "pdf_images"),
    "/pmd/": os.path.join(ROOT, "pdf_markdown"),
}

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
}

CHUNK = 1 << 20  # 1MB


def resolve(path):
    """把 URL 路径映射到本地文件，越界返回 None。"""
    if path.startswith("/api/"):
        return None
    for prefix, base in ROUTES.items():
        if path.startswith(prefix):
            rel = urllib.parse.unquote(path[len(prefix):])
            target = os.path.realpath(os.path.join(base, rel))
            if target.startswith(os.path.realpath(base) + os.sep):
                return target
            return None
    rel = urllib.parse.unquote(path.lstrip("/")) or "index.html"
    target = os.path.realpath(os.path.join(WEB_DIR, rel))
    if target.startswith(os.path.realpath(WEB_DIR) + os.sep):
        return target
    return None


def load_progress():
    if os.path.isfile(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


class Handler(BaseHTTPRequestHandler):
    server_version = "StudyServer/1.0"
    protocol_version = "HTTP/1.1"

    ICON_PATHS = {"/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"}

    def log_message(self, fmt, *args):
        p = self.path or ""
        if "/api/" in p or "progress" in p:
            return  # 进度心跳太频繁，不打日志
        if p in self.ICON_PATHS:
            return  # 图标请求未命中文件时日志刷屏，静默
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- GET ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path in self.ICON_PATHS:
            return self.send_redirect("/favicon.svg")

        if path == "/api/courses":
            # 索引未生成时返回空结构，前端据此提示先跑 build_index.py，而不是直接报错
            return self.send_data_file(os.path.join(DATA_DIR, "courses.json"),
                                       {"meta": {"totalCourses": 0, "totalPages": 0},
                                        "groups": [], "courses": []})
        if path == "/api/pages":
            return self.send_data_file(os.path.join(DATA_DIR, "pages.json"), [])
        if path == "/api/progress":
            return self.send_json(load_progress())

        target = resolve(path)
        if not target or not os.path.isfile(target):
            return self.send_error(404, "Not Found")
        # web 资源(HTML/CSS/JS/JSON)不设缓存，避免浏览器沿用损坏旧版导致空白页
        ext = os.path.splitext(target)[1].lower()
        self.send_file(target, cache=ext not in (".html", ".css", ".js", ".json"))

    # ---------- POST ----------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/progress":
            return self.send_error(404)

        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send_error(400, "Bad JSON")

        data = load_progress()
        cid = str(payload.get("id", ""))
        if not cid:
            return self.send_error(400, "Missing id")
        prev = data.get(cid) or {}
        data[cid] = {
            "position": float(payload.get("position") or 0),
            "duration": float(payload.get("duration") or 0),
            "status": payload.get("status") or "learning",
            # finished：完整播完过一次 / 手动标记完成。未携带时沿用旧值，避免被覆盖丢失
            "finished": bool(payload["finished"]) if "finished" in payload else bool(prev.get("finished")),
            "page": payload.get("page"),
            "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        tmp = PROGRESS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, PROGRESS_FILE)
        return self.send_json({"ok": True})

    # ---------- 响应 ----------
    def content_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, "application/octet-stream")

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_data_file(self, path, fallback):
        """索引文件不存在时返回兜底空结构，避免 500 与前端白屏。"""
        if not os.path.isfile(path):
            return self.send_json(fallback)
        return self.send_file(path, cache=False)

    def send_redirect(self, location):
        body = b""
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_file(self, path, cache=True):
        size = os.path.getsize(path)
        ctype = self.content_type(path)
        start, end = 0, size - 1
        status = 200

        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
            if m:
                first, last = m.group(1), m.group(2)
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                elif last:  # bytes=-N 取末尾 N 字节
                    start = max(0, size - int(last))
                    end = size - 1
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        if cache:
            # 视频/图片允许浏览器做短时媒体缓冲，但不长期缓存整文件，避免内存/磁盘被大视频占满
            self.send_header("Cache-Control", "private, max-age=0")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()

        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    buf = f.read(min(CHUNK, left))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    left -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self):
        path = urllib.parse.urlparse(self.path).path
        if path in self.ICON_PATHS:
            return self.send_redirect("/favicon.svg")
        if path.startswith("/api/"):
            return self.send_error(404)
        target = resolve(path)
        if not target or not os.path.isfile(target):
            return self.send_error(404)
        self.send_file(target)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.makedirs(DATA_DIR, exist_ok=True)
    for prefix, base in ROUTES.items():
        if not os.path.isdir(base):
            print("警告: 目录不存在 %s -> %s" % (prefix, base))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print("学习系统已启动: http://127.0.0.1:%d" % port)
    print("数据根目录:", ROOT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        srv.server_close()


if __name__ == "__main__":
    main()
