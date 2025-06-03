FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt .
RUN pip install -r requirements.txt -t python/

COPY backend/ backend/
COPY frontend/ frontend/

RUN zip -r deployment.zip . 