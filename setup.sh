#!/bin/bash

# Create virtual environment in the correct location
python3 -m venv /usr/share/nginx/pomodorify/venv

# Activate virtual environment and install dependencies
source /usr/share/nginx/pomodorify/venv/bin/activate
pip install -r requirements.txt
pip install gunicorn

# Set correct permissions
sudo chown -R ec2-user:ec2-user /usr/share/nginx/pomodorify

# Reload systemd and restart service
sudo systemctl daemon-reload
sudo systemctl restart pomodorify 