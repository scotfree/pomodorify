# Pomodorify

A static web app that allows users to log into their Spotify account, select a playlist, and create a new playlist of a configurable length (default 25 minutes).

## Features

- Spotify OAuth login
- Playlist selection
- Configurable playlist length
- Random song selection up to the time limit
- Private playlist creation
- Pure client-side implementation - no server required!

## Setup

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd pomo
   ```

2. **Configure Spotify credentials**:
   - Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Create a new application
   - Copy your Client ID
   - Add your redirect URI: `https://yourdomain.com` (replace with your actual domain)

3. **Update the Client ID**:
   - Open `frontend/app.js`
   - Replace `'bac207f49dc041e0a2e8a92691c7a23a'` with your actual Client ID

## Deployment

This is a pure static application with no server-side dependencies. You can deploy it anywhere:

### Option 1: Any Web Server
Simply upload these files to your web server:
- `frontend/index.html`
- `frontend/app.js`
- `frontend/style.css`

### Option 2: GitHub Pages
1. Push your code to a GitHub repository
2. Enable GitHub Pages in repository settings
3. Your app will be available at `https://username.github.io/repository-name`

### Option 3: Netlify/Vercel
1. Connect your GitHub repository
2. Deploy automatically on push

### Option 4: AWS S3 + CloudFront
1. Upload files to S3 bucket
2. Configure CloudFront distribution
3. Point your domain to CloudFront

## How It Works

- **Authentication**: Uses Spotify's Authorization Code flow with PKCE
- **Token Management**: Stores tokens securely in browser localStorage
- **API Calls**: Makes direct calls to Spotify Web API from the browser
- **Playlist Generation**: Randomly selects tracks up to the specified duration
- **No Backend**: Everything runs in the browser - no server required!

## Security

- Client ID is visible in the code (this is normal for OAuth client-side apps)
- No sensitive data is stored on any server
- All operations are authorized by the user through Spotify's OAuth flow
- Tokens are stored locally in the user's browser

## Files

- `frontend/index.html` - Main HTML file
- `frontend/app.js` - JavaScript application logic
- `frontend/style.css` - Styling
- `config/` - Configuration files (for reference)
