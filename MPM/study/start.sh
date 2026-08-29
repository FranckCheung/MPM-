#!/bin/bash
# 软考中项本地学习系统 —— 启动脚本
# 用法: ./start.sh [端口，默认 8765]
set -e
cd "$(dirname "$0")"
PORT="${1:-8765}"
echo "正在生成/校验索引…"
python3 build_index.py >/dev/null
echo "启动服务: http://127.0.0.1:$PORT"
exec python3 server.py "$PORT"
