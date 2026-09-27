# RapidOCR on ONNX Runtime, not PaddlePaddle: paddle has no arm64 wheel.
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 OMP_NUM_THREADS=2
WORKDIR /app
COPY requirements.txt .
# opencv-python needs libGL on slim; headless has the same API without it.
RUN pip install -r requirements.txt \
 && pip uninstall -y opencv-python \
 && pip install opencv-python-headless==4.11.0.86
COPY app.py .
# Exercise the bundled models at build time: fail here, not on the first photo.
RUN python -c "from PIL import Image; import io; from rapidocr import RapidOCR; b=io.BytesIO(); Image.new('RGB',(64,32),'white').save(b,format='PNG'); RapidOCR()(b.getvalue()); print('models ok')"
RUN useradd --create-home --uid 10001 dm
USER dm
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
