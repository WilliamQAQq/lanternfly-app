from pathlib import Path
from typing import Any

import gradio as gr
from PIL import Image
from ultralytics import YOLO

MODEL_PATH = Path(__file__).resolve().parent / "best.pt"
CONF_THRESHOLD = 0.7
MODEL = YOLO(str(MODEL_PATH))


def _extract_detections(result: Any) -> list[dict[str, Any]]:
    """Convert Ultralytics Results boxes into JSON-serializable xywh dicts."""
    dets: list[dict[str, Any]] = []
    if result.boxes is None:
        return dets
    for box in result.boxes:
        x0, y0, x1, y1 = box.xyxy[0].tolist()
        cls_id = int(box.cls)
        label = MODEL.names.get(cls_id, str(cls_id))
        dets.append({
            "label": label,
            "confidence": round(float(box.conf), 3),
            "box": [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)],
        })
    return dets


def predict(img: Image.Image | None) -> tuple[list[dict[str, Any]], Any]:
    """Run YOLO detection, return structured detections + RGB annotated image."""
    if img is None:
        return [], None
    results = MODEL(img, conf=CONF_THRESHOLD)[0]
    dets = _extract_detections(results)
    # Ultralytics plot() returns BGR; reverse channel order for Gradio RGB display
    annotated = results.plot()[..., ::-1]
    return dets, annotated


def api_predict(img: Image.Image | None) -> dict[str, list[dict[str, Any]]]:
    """JSON-only detection wrapper for REST/Gradio API callers."""
    dets, _ = predict(img)
    return {"detections": dets}


with gr.Blocks(title="Spot-a-Lanternfly — YOLO") as demo:
    gr.Markdown("# Spot-a-Lanternfly — YOLO Detector\nDetects spotted lanternflies (Adult / Early Nymph / Late Nymph) and returns bounding boxes + confidence.")
    img_input = gr.Image(type="pil", label="Upload photo", render=False)
    dets_output = gr.JSON(label="Detections", render=False)
    ann_output = gr.Image(type="numpy", label="Annotated", render=False)
    gr.Interface(
        fn=predict,
        inputs=img_input,
        outputs=[dets_output, ann_output],
        flagging_mode="never",
    )
    # Bind via gr.Image/gr.JSON components so Gradio preprocesses uploaded files/URLs into PIL.Image (unlike gr.api)
    gr.on(
        triggers=[],
        fn=api_predict,
        inputs=img_input,
        outputs=dets_output,
        api_name="yolo_detect",
    )

if __name__ == "__main__":
    demo.launch()
