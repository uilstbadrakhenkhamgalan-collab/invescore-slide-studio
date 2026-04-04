FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/main.py .
COPY backend/template_engine.py .
COPY backend/brand_guide.json .
COPY backend/templates/ templates/

CMD ["python", "-c", "import os,uvicorn; uvicorn.run('main:app', host='0.0.0.0', port=int(os.environ.get('PORT', 8000)))"]
