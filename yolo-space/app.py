import gradio as gr
from PIL import Image
from ultralytics import YOLO

MODEL = YOLO("best.pt")


def predict(img):
    """Run YOLO detection, return structured detections + RGB annotated image."""
    results = MODEL(img, conf=0.25)[0]
    dets = []
    if results.boxes is not None:
        for b in results.boxes:
            x0, y0, x1, y1 = b.xyxy[0].tolist()
            cls_id = int(b.cls)
            label = MODEL.names.get(cls_id, str(cls_id))
            dets.append({
                "label": label,
                "confidence": round(float(b.conf), 3),
                "box": [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)],
            })
    # Ultralytics plot() returns BGR; reverse channel order for Gradio RGB display
    annotated = results.plot()[..., ::-1]
    return dets, annotated


def api_predict(img: Image.Image) -> dict:
    """JSON-only detection wrapper for REST/Gradio API callers."""
    dets, _ = predict(img)
    return {"detections": dets}


with gr.Blocks(title="Spot-a-Lanternfly — YOLO") as demo:
    gr.Markdown("# Spot-a-Lanternfly — YOLO Detector\nDetects spotted lanternflies (Adult / Early Nymph / Late Nymph) and returns bounding boxes + confidence.")
    gr.Interface(
        fn=predict,
        inputs=gr.Image(type="pil", label="Upload photo"),
        outputs=[
            gr.JSON(label="Detections"),
            gr.Image(type="numpy", label="Annotated"),
        ],
        flagging_mode="never",
    )
    gr.api(api_predict, api_name="yolo_detect")

if __name__ == "__main__":
    demo.launch()
