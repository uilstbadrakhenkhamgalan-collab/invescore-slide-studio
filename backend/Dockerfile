FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY backend/main.py .
COPY backend/template_engine.py .
COPY backend/brand_guide.json .

# Copy the master template
COPY backend/templates/ templates/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
