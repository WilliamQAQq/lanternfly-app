import gradio as gr
from ultralytics import YOLO
import numpy as np

MODEL = YOLO("best.pt")

def predict(img):
    """Run YOLO detection, return annotated image + structured detections."""
    results = MODEL(img, conf=0.25)[0]
    dets = []
    if results.boxes is not None:
        for b in results.boxes:
            x0, y0, x1, y1 = b.xyxy[0].tolist()
            dets.append({
                "label": "lanternfly",
                "confidence": round(float(b.conf), 3),
                "box": [round(x0, 1), round(y0, 1), round(x1 - x0, 1), round(y1 - y0, 1)],
            })
    annotated = results.plot()
    return dets, annotated

demo = gr.Interface(
    fn=predict,
    inputs=gr.Image(type="pil", label="Upload photo"),
    outputs=[
        gr.JSON(label="Detections"),
        gr.Image(type="numpy", label="Annotated"),
    ],
    title="Spot-a-Lanternfly — YOLOv11-Nano",
    description="Circles lanternflies and returns detection probability.",
    allow_flagging="never",
)

# REST endpoint for the website frontend:
# POST multipart form with field "image" -> {detections: [...], }
def api_predict(img):
    dets, annotated = predict(img)
    return {"detections": dets}

api = gr.api(fn=api_predict, inputs=gr.Image(type="pil"), outputs=gr.JSON(),
             api_name="yolo_detect")

if __name__ == "__main__":
    demo.launch()
