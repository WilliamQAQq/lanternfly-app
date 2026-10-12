---
title: Spot-a-Lanternfly YOLOv11-Nano
emoji: 🪲
colorFrom: green
colorTo: red
sdk: gradio
sdk_version: 5.0.0
app_file: app.py
pinned: false
---

# Spot-a-Lanternfly — YOLOv11-Nano detector

Trained locally (RTX 4060) on spotted-lanternfly photos with pseudo-labels from OWLv2.
Circles lanternflies and returns confidence.

- Model: YOLOv11-Nano (~5.5MB)
- Classes: `lanternfly` (single class)
- REST endpoint: `POST /yolo_detect` (multipart field `image`)

mAP50 ~0.69 on held-out val.
