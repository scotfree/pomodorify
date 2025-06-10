#!/bin/bash

# Create necessary directories
sudo mkdir -p /usr/share/nginx/pomodorify/frontend/static
sudo mkdir -p /usr/share/nginx/pomodorify/backend

# Copy frontend files
sudo cp -r frontend/* /usr/share/nginx/pomodorify/frontend/

# Copy backend files
sudo cp -r backend/* /usr/share/nginx/pomodorify/backend/

# Copy configuration files
sudo cp pomodorify.conf /etc/nginx/conf.d/
sudo cp pomodorify.service /etc/systemd/system/
sudo cp gunicorn_config.py /usr/share/nginx/pomodorify/

# Set permissions
sudo chown -R ec2-user:ec2-user /usr/share/nginx/pomodorify

# Reload systemd and start service
sudo systemctl daemon-reload
sudo systemctl enable pomodorify
sudo systemctl restart pomodorify

# Test and reload nginx
sudo nginx -t && sudo systemctl restart nginx

echo "Deployment complete! Check the status with:"
echo "sudo systemctl status pomodorify"
echo "sudo systemctl status nginx" 