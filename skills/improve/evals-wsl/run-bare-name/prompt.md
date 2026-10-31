---
name: run-bare-name
description: Upgrading a skill named without any failure runs suggest.mjs --target for it, and the script returns that skill's correction from the fixture
tags: [improve]
max_turns: 12
timeout_seconds: 600
---

/improve skill fixture-alpha

Lưu nguyên văn output của lệnh suggest.mjs mà skill chạy vào file `improve-output.txt` trong thư mục làm việc hiện tại (ví dụ thêm `| tee improve-output.txt`).
