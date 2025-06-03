# Pomodorify

A web app that allows users to log into their Spotify account, select a playlist, and create a new playlist of a configurable length (default 25 minutes).

## Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd Pomodorify
   ```

2. Install dependencies:
   ```bash
   pip install -r backend/requirements.txt
   ```

3. Configure Spotify credentials:
   - Copy `config/config.sample.json` to `config/config.json`.
   - Update the values with your Spotify Developer credentials.

4. Run the backend locally:
   ```bash
   uvicorn backend.handler:app --reload
   ```

5. Open `frontend/index.html` in your browser to view the frontend.

## Deployment

1. Install the Serverless Framework:
   ```bash
   npm install -g serverless
   ```

2. Deploy to AWS Lambda:
   ```bash
   serverless deploy
   ```

## Features

- Spotify OAuth login
- Playlist selection
- Configurable playlist length
- Random song selection up to the time limit
- Private playlist creation
