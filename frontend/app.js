class PomodorifyApp {
    constructor() {
        this.clientId = 'bac207f49dc041e0a2e8a92691c7a23a';
        this.redirectUri = 'https://pomodorifi.es';
        this.scope = 'user-read-private user-read-email playlist-read-private playlist-modify-private';
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
        this.discoverWeeklyPlaylistId = null;

        this.initializeApp();
    }

    initializeApp() {
        this.loadTokensFromStorage();
        this.setupEventListeners();
        this.handleAuthCallback();
        this.updateUI();
    }

    setupEventListeners() {
        const loginButton = document.getElementById('login-button');
        const generateButton = document.getElementById('generate-button');
        const saveButton = document.getElementById('save-button');
        const regenerateButton = document.getElementById('regenerate-button');
        const createAnotherButton = document.getElementById('create-another-button');
        const logoutButton = document.getElementById('logout-button');
        const backButton = document.getElementById('back-button');
        const discoverWeeklyButton = document.getElementById('discover-weekly-button');
        const searchInput = document.getElementById('search-input');

        loginButton?.addEventListener('click', () => this.login());
        generateButton?.addEventListener('click', () => this.generatePlaylist());
        saveButton?.addEventListener('click', () => this.savePlaylist());
        regenerateButton?.addEventListener('click', () => this.generatePlaylist());
        createAnotherButton?.addEventListener('click', () => this.showPlaylistSection());
        logoutButton?.addEventListener('click', () => this.logout());
        backButton?.addEventListener('click', () => this.showPlaylistSection());
        discoverWeeklyButton?.addEventListener('click', () => this.useDiscoverWeekly());
        searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.generatePlaylist();
            }
        });
    }

    loadTokensFromStorage() {
        this.accessToken = localStorage.getItem('spotify_access_token');
        this.refreshToken = localStorage.getItem('spotify_refresh_token');
        const expiry = localStorage.getItem('spotify_token_expiry');
        this.tokenExpiry = expiry ? parseInt(expiry) : null;
    }

    saveTokensToStorage(tokenData) {
        this.accessToken = tokenData.access_token;
        this.refreshToken = tokenData.refresh_token || this.refreshToken;
        this.tokenExpiry = Date.now() + (tokenData.expires_in * 1000);

        localStorage.setItem('spotify_access_token', this.accessToken);
        if (this.refreshToken) {
            localStorage.setItem('spotify_refresh_token', this.refreshToken);
        }
        localStorage.setItem('spotify_token_expiry', this.tokenExpiry.toString());
    }

    // Generate a random string for PKCE
    generateRandomString(length) {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let text = '';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    // Generate code challenge for PKCE
    async generateCodeChallenge(codeVerifier) {
        const encoder = new TextEncoder();
        const data = encoder.encode(codeVerifier);
        const digest = await crypto.subtle.digest('SHA-256', data);
        
        return btoa(String.fromCharCode(...new Uint8Array(digest)))
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    }

    async refreshAccessToken() {
        if (!this.refreshToken) return false;

        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: this.refreshToken,
                    client_id: this.clientId,
                }),
            });

            if (response.ok) {
                const tokenData = await response.json();
                this.saveTokensToStorage(tokenData);
                return true;
            }
        } catch (error) {
            console.error('Failed to refresh token:', error);
        }

        return false;
    }

    async ensureValidToken() {
        if (!this.accessToken) return false;

        // Check if token is expired or will expire soon (within 5 minutes)
        if (this.tokenExpiry && Date.now() > (this.tokenExpiry - 300000)) {
            return await this.refreshAccessToken();
        }

        return true;
    }

    async login() {
        // Generate PKCE parameters
        this.codeVerifier = this.generateRandomString(128);
        const codeChallenge = await this.generateCodeChallenge(this.codeVerifier);
        
        // Store code verifier for later use
        localStorage.setItem('code_verifier', this.codeVerifier);

        const params = new URLSearchParams({
            client_id: this.clientId,
            response_type: 'code',
            redirect_uri: this.redirectUri,
            scope: this.scope,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
        });

        window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    async handleAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');

        if (code) {
            try {
                await this.exchangeCodeForToken(code);
                // Remove the code from URL
                window.history.replaceState({}, document.title, window.location.pathname);
                this.updateUI();
                await this.loadPlaylists();
            } catch (error) {
                console.error('Authentication failed:', error);
                alert('Authentication failed. Please try again.');
            }
        }
    }

    async exchangeCodeForToken(code) {
        // Get the code verifier from localStorage
        const codeVerifier = localStorage.getItem('code_verifier');
        
        if (!codeVerifier) {
            throw new Error('No code verifier found');
        }

        const response = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: this.redirectUri,
                client_id: this.clientId,
                code_verifier: codeVerifier,
            }),
        });

        if (!response.ok) {
            throw new Error('Failed to exchange code for token');
        }

        const tokenData = await response.json();
        this.saveTokensToStorage(tokenData);
        
        // Clean up the code verifier
        localStorage.removeItem('code_verifier');
    }

    async loadPlaylists() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        try {
            const allPlaylists = [];
            let offset = 0;
            const limit = 50; // Spotify's max per request
            
            // Fetch playlists in batches until we have 100 or no more available
            while (allPlaylists.length < 100) {
                const response = await fetch(`https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`, {
                    headers: {
                        'Authorization': `Bearer ${this.accessToken}`,
                    },
                });

                if (!response.ok) {
                    throw new Error('Failed to fetch playlists');
                }

                const data = await response.json();
                
                // Filter out POMO_ playlists and add to our collection
                const filteredPlaylists = data.items.filter(playlist => !playlist.name.startsWith('POMO_'));
                allPlaylists.push(...filteredPlaylists);
                
                // If we got fewer than the limit, we've reached the end
                if (data.items.length < limit) {
                    break;
                }
                
                offset += limit;
            }
            
            // Limit to 100 playlists
            const finalPlaylists = allPlaylists.slice(0, 100);
            
            if (finalPlaylists.length === 0) {
                const select = document.getElementById('playlist-select');
                select.innerHTML = '<option value="">No playlists found</option>';
                return;
            }
            
            // Find Discover Weekly playlist
            this.findDiscoverWeeklyPlaylist(finalPlaylists);
            
            this.populatePlaylistSelect(finalPlaylists);
        } catch (error) {
            console.error('Failed to load playlists:', error);
            alert('Failed to load playlists. Please try again.');
        }
    }

    findDiscoverWeeklyPlaylist(playlists) {
        // Look for the most recent Discover Weekly playlist
        const discoverWeeklyPlaylists = playlists.filter(playlist => 
            playlist.name.toLowerCase().includes('discover weekly') && 
            playlist.owner.display_name === 'Spotify'
        );
        
        if (discoverWeeklyPlaylists.length > 0) {
            // Get the most recent one (they're usually ordered by creation date)
            this.discoverWeeklyPlaylistId = discoverWeeklyPlaylists[0].id;
            console.log('Found Discover Weekly playlist:', this.discoverWeeklyPlaylistId);
            
            // Enable the Discover Weekly button
            const discoverWeeklyButton = document.getElementById('discover-weekly-button');
            if (discoverWeeklyButton) {
                discoverWeeklyButton.disabled = false;
                discoverWeeklyButton.style.opacity = '1';
            }
        } else {
            // No Discover Weekly playlist found
            this.discoverWeeklyPlaylistId = null;
            console.log('No Discover Weekly playlist found');
            
            // Disable the Discover Weekly button
            const discoverWeeklyButton = document.getElementById('discover-weekly-button');
            if (discoverWeeklyButton) {
                discoverWeeklyButton.disabled = true;
                discoverWeeklyButton.style.opacity = '0.5';
            }
        }
    }

    populatePlaylistSelect(playlists) {
        const select = document.getElementById('playlist-select');
        select.innerHTML = '';

        // Add a default option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- Select a playlist --';
        select.appendChild(defaultOption);

        playlists.forEach(playlist => {
            const option = document.createElement('option');
            option.value = playlist.id;
            option.textContent = playlist.name;
            select.appendChild(option);
        });
    }

    getShortTimestamp() {
        const now = new Date();
        const month = now.toLocaleDateString('en-US', { month: 'short' });
        const day = now.getDate().toString().padStart(2, '0');
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        
        return `${month}${day}_${hours}${minutes}`;
    }

    async generatePlaylist() {
        console.log('generatePlaylist called');
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        const searchQuery = document.getElementById('search-input').value.trim();
        const playlistId = document.getElementById('playlist-select').value;
        const duration = parseInt(document.getElementById('duration').value);

        console.log('Search query:', searchQuery, 'Playlist ID:', playlistId, 'Duration:', duration);

        // Check if search input is provided
        if (searchQuery) {
            console.log('Using search input, calling generatePlaylistFromSearch');
            await this.generatePlaylistFromSearch();
            return;
        }

        // Fall back to playlist selection
        if (!playlistId) {
            alert('Please select a playlist or enter a search term.');
            return;
        }

        console.log('Using playlist selection');
        try {
            // Get playlist tracks
            const tracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!tracksResponse.ok) {
                throw new Error('Failed to fetch playlist tracks');
            }

            const tracksData = await tracksResponse.json();
            const tracks = tracksData.items
                .filter(item => item.track)
                .map(item => ({
                    uri: item.track.uri,
                    name: item.track.name,
                    artist: item.track.artists[0].name,
                    duration_ms: item.track.duration_ms,
                }));

            // Get source playlist name
            const playlistSelect = document.getElementById('playlist-select');
            const sourcePlaylistName = playlistSelect.options[playlistSelect.selectedIndex].textContent;

            // Select tracks for the duration
            const selectedTracks = this.selectTracksForDuration(tracks, duration);
            this.displayPreview(selectedTracks, sourcePlaylistName);
        } catch (error) {
            console.error('Failed to generate playlist:', error);
            alert('Failed to generate playlist. Please try again.');
        }
    }

    async useDiscoverWeekly() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        if (!this.discoverWeeklyPlaylistId) {
            alert('Discover Weekly playlist not available. Please select a playlist manually.');
            return;
        }

        try {
            console.log('Using stored Discover Weekly playlist ID:', this.discoverWeeklyPlaylistId);
            
            // Get playlist tracks using the stored ID
            const tracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${this.discoverWeeklyPlaylistId}/tracks`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!tracksResponse.ok) {
                throw new Error('Failed to fetch Discover Weekly tracks');
            }

            const tracksData = await tracksResponse.json();
            const tracks = tracksData.items
                .filter(item => item.track)
                .map(item => ({
                    uri: item.track.uri,
                    name: item.track.name,
                    artist: item.track.artists[0].name,
                    duration_ms: item.track.duration_ms,
                }));

            const duration = parseInt(document.getElementById('duration').value);
            const selectedTracks = this.selectTracksForDuration(tracks, duration);
            this.displayPreview(selectedTracks, 'Discover Weekly');
        } catch (error) {
            console.error('Failed to use Discover Weekly:', error);
            alert('Failed to use Discover Weekly. Please try again.');
        }
    }

    async generatePlaylistFromSearch() {
        console.log('generatePlaylistFromSearch called');
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        const searchQuery = document.getElementById('search-input').value.trim();
        const duration = parseInt(document.getElementById('duration').value);

        console.log('Search query:', searchQuery, 'Duration:', duration);

        if (!searchQuery) {
            alert('Please enter a search term.');
            return;
        }

        try {
            console.log('Searching for tracks...');
            // Search for tracks
            const searchResponse = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=50`, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!searchResponse.ok) {
                throw new Error('Failed to search for tracks');
            }

            const searchData = await searchResponse.json();
            console.log('Search results:', searchData.tracks.items.length, 'tracks found');
            
            const tracks = searchData.tracks.items.map(track => ({
                uri: track.uri,
                name: track.name,
                artist: track.artists[0].name,
                duration_ms: track.duration_ms,
            }));

            // Select tracks for the duration
            const selectedTracks = this.selectTracksForDuration(tracks, duration);
            console.log('Selected tracks:', selectedTracks.length);
            
            // Create sanitized search string for playlist name
            const sanitizedSearch = searchQuery
                .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters
                .replace(/\s+/g, ' ') // Replace multiple spaces with single space
                .trim()
                .substring(0, 30); // Limit to 30 characters
            
            console.log('Displaying preview with source:', `search_${sanitizedSearch}`);
            this.displayPreview(selectedTracks, `search_${sanitizedSearch}`);
        } catch (error) {
            console.error('Failed to generate playlist from search:', error);
            alert('Failed to generate playlist from search. Please try again.');
        }
    }

    selectTracksForDuration(tracks, durationMinutes) {
        const durationLimit = durationMinutes * 60 * 1000; // Convert to milliseconds
        const shuffledTracks = [...tracks].sort(() => Math.random() - 0.5);
        
        const selectedTracks = [];
        let totalDuration = 0;

        for (const track of shuffledTracks) {
            if (totalDuration + track.duration_ms <= durationLimit) {
                selectedTracks.push(track);
                totalDuration += track.duration_ms;
            } else {
                // Add one more track even if it exceeds the limit
                selectedTracks.push(track);
                totalDuration += track.duration_ms;
                break;
            }
        }

        return selectedTracks;
    }

    displayPreview(tracks, sourcePlaylistName) {
        const totalDuration = tracks.reduce((sum, track) => sum + track.duration_ms, 0);

        // Generate default name
        const timestamp = this.getShortTimestamp();
        let defaultName;
        
        if (sourcePlaylistName.startsWith('search_')) {
            // For search results, use the format: POMO_search_SEARCHSTRING
            defaultName = `POMO_${sourcePlaylistName}_${timestamp}`;
        } else {
            // For playlist selections, use the format: POMO_PLAYLISTNAME
            defaultName = `POMO_${sourcePlaylistName}_${timestamp}`;
        }
        
        // Set the name field with default name
        const nameInput = document.getElementById('preview-playlist-name');
        nameInput.value = defaultName;

        // Update preview info
        document.getElementById('preview-source-name').textContent = sourcePlaylistName;
        document.getElementById('preview-duration').textContent = this.formatDuration(totalDuration);
        document.getElementById('preview-track-count').textContent = tracks.length.toString();

        // Display tracks
        const trackList = document.getElementById('preview-tracks');
        trackList.innerHTML = '';

        tracks.forEach(track => {
            const trackItem = document.createElement('div');
            trackItem.className = 'track-item';
            trackItem.innerHTML = `
                <div class="track-info">
                    <div class="track-name">${track.name}</div>
                    <div class="track-artist">${track.artist}</div>
                </div>
                <div class="track-duration">${this.formatDuration(track.duration_ms)}</div>
            `;
            trackList.appendChild(trackItem);
        });

        // Store tracks for saving
        window.currentPreview = { tracks, totalDuration: totalDuration, sourcePlaylistName };

        // Show preview section
        this.showPreviewSection();
    }

    async savePlaylist() {
        if (!(await this.ensureValidToken())) {
            this.showLoginSection();
            return;
        }

        const preview = window.currentPreview;
        if (!preview) {
            alert('No playlist to save. Please generate a playlist first.');
            return;
        }

        // Get playlist name, use default if empty
        const nameInput = document.getElementById('preview-playlist-name');
        let playlistName = nameInput.value.trim();
        
        if (!playlistName) {
            const timestamp = this.getShortTimestamp();
            playlistName = `POMO_${preview.sourcePlaylistName}_${timestamp}`;
        }

        try {
            // Get current user
            const userResponse = await fetch('https://api.spotify.com/v1/me', {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                },
            });

            if (!userResponse.ok) {
                throw new Error('Failed to get user info');
            }

            const user = await userResponse.json();

            // Create playlist
            const createResponse = await fetch(`https://api.spotify.com/v1/users/${user.id}/playlists`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: playlistName,
                    public: false,
                }),
            });

            if (!createResponse.ok) {
                throw new Error('Failed to create playlist');
            }

            const newPlaylist = await createResponse.json();

            // Add tracks to playlist
            const addTracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${newPlaylist.id}/tracks`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    uris: preview.tracks.map(track => track.uri),
                }),
            });

            if (!addTracksResponse.ok) {
                throw new Error('Failed to add tracks to playlist');
            }

            // Show success
            this.showResultSection(newPlaylist.external_urls.spotify);
        } catch (error) {
            console.error('Failed to save playlist:', error);
            alert('Failed to save playlist. Please try again.');
        }
    }

    formatDuration(ms) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    updateUI() {
        if (this.accessToken) {
            this.showPlaylistSection();
        } else {
            this.showLoginSection();
        }
    }

    showLoginSection() {
        document.getElementById('login-section').style.display = 'block';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'none';
    }

    showPlaylistSection() {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'block';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'none';
    }

    showPreviewSection() {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'block';
        document.getElementById('result-section').style.display = 'none';
    }

    showResultSection(playlistUrl) {
        document.getElementById('login-section').style.display = 'none';
        document.getElementById('playlist-section').style.display = 'none';
        document.getElementById('preview-section').style.display = 'none';
        document.getElementById('result-section').style.display = 'block';

        const playlistLink = document.getElementById('playlist-link');
        playlistLink.href = playlistUrl;
    }

    async logout() {
        localStorage.removeItem('spotify_access_token');
        localStorage.removeItem('spotify_refresh_token');
        localStorage.removeItem('spotify_token_expiry');
        localStorage.removeItem('code_verifier');
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
        this.updateUI();
        alert('Logged out successfully!');
    }
}

// Initialize the app when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new PomodorifyApp();
});
