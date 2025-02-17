# transcriptionViewer

transcriptionViewer is a Node.js/Express application that displays radio-transcribed messages, supports user authentication, and provides both real-time updates (via WebSockets) and pagination. It is designed to help track, search, and manage radio call transcriptions, with a focus on modularity, caching, and flexible talkgroup configurations defined in `.env` or via CSV data.

---

## Features

1. **Real-Time Updates**  
   - Uses WebSockets to broadcast new transcriptions (and optional autoplay audio) to connected clients.  
   - A toggle (Auto-Play Audio) allows users to automatically queue incoming transcriptions' audio.

2. **Pagination**  
   - A "Load More" button fetches older messages in timestamp-descending order.  
   - This is done via an `/api/transcriptions` route, returning JSON data that the client appends on the page.

3. **Talkgroup-Based Filtering**  
   - `.env` variables define "EMS," "HAM," or other groups using numeric ranges or single IDs.  
   - Users can filter the displayed transcriptions by talkgroup group name (e.g. `EMS`, `HAM`, `RUTHERFORD`, etc.).

4. **Caching Layer**  
   - For the initial homepage, short-term caching is used to reduce DB load (e.g. `recent_transcriptions_30_EMS`).  
   - Cache invalidation occurs on new upload or relevant events.

5. **Timestamp Handling**  
   - Timestamps are stored in MongoDB, and the UI typically renders them in local time.  
   - For "Load More," the server uses a timestamp-based approach (e.g. `?before=<ISODateString>`) to fetch older messages continuously.

6. **LLM (AI) Analysis**
   - Integrated support for both OpenAI and Google AI models
   - Analyze transcriptions within a specified date range
   - Historical view of all AI interactions
   - Admin monitoring of LLM usage

7. **Theme System**
   - Multiple built-in themes:
     - Light & Dark modes
     - Ultra Dark for low-light environments
     - Color Psychology theme
     - Vibrant Sunrise
     - Serene Ocean
     - Intelligence Agency theme
   - Theme preference persistence
   - Responsive design with mobile-optimized text sizes

8. **Admin Features**
    - User management interface
    - Tier modification controls
    - LLM interaction monitoring

---

## Architecture Overview

1. **Node.js + Express**  
   - `indexRoutes.js` handles the main homepage, caching, tier-based logic.  
   - `apiRoutes.js` handles file uploads and additional API endpoints (e.g. `toggle-autoplay`).  
   - `searchRoutes.js` handles searching transcriptions with user-tier checks.
   - `aiRoutes.js` manages LLM interactions and analysis.
   - `adminRoutes.js` provides admin functionality.

2. **MongoDB**  
   - Stores transcriptions in a `transcriptions` collection (the timestamp is a key field).  
   - A `Talkgroup` collection can store extended talkgroup info (IDs, alpha tags, etc.).
   - `LLMInteraction` collection for AI analysis history.

3. **EJS Templating**  
   - `index.ejs` shows the main feed of transcriptions, dynamic "Load More" button, talkgroup filters, etc.
   - Responsive design with mobile-first approach
   - Accessibility features including ARIA labels and keyboard navigation

4. **WebSockets**  
   - Defined in `webSocketService.js`, broadcasting `newTranscription` and `nextAudio` messages to clients.  
   - The client (in `/js/main.js`) listens for these messages to optionally play audio or insert new lines in real-time.

5. **Environment + CSV**  
   - `.env` controls database config, talkgroup range definitions, tier group keys, etc.  
   - CSV configuration (`talkgroupConfig.js`):
     - Parses `talkgroups.csv` on startup
     - Validates entries against GROUP_KEYS
     - Upserts talkgroup metadata into MongoDB
     - Provides real-time mapping of TGIDs to friendly names
     - Enables advanced search and filtering capabilities
     - Maintains data consistency with periodic reloads

---

## Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/swiftraccoon/sdrTrunkTranscription.git
cd sdrTrunkTranscription/transcription_viewer
npm install
```

### 2. Set Up `.env`

Create a `.env` file with keys such as:

```
# Database and Session Configuration
DATABASE_URL=mongodb://127.0.0.1/transcriptionViewer
SESSION_SECRET=supersecretstring

# Website Configuration
WEBSITE_URL=https://your-domain.com
WEBSITE_NAME=TranscriptionViewer
HTTPS_ENABLE=true

# SSL Configuration (if HTTPS_ENABLE=true)
SSL_KEY_PATH=privkey.pem
SSL_CERT_PATH=fullchain.pem

# API Keys
API_KEY=your_upload_api_key
OPENAI_API_KEY=your_openai_api_key

# Talkgroup Configuration
GROUP_KEYS=PUBLIC_SAFETY,HAM,STATEWIDE,TACTICAL
PUBLIC_SAFETY=0-9959,10000-99999
HAM=9960-9999
# Add more group definitions as needed
```

### 3. Configure Talkgroup Metadata (Optional)

You can provide additional metadata for talkgroups using a CSV file. This allows you to associate names, descriptions, and other details with specific Talkgroup IDs (TGIDs). The system uses this metadata to provide friendly names and grouping capabilities.

Place your CSV file as `trs_tg_7118.csv` in the `utils` directory. You can obtain talkgroup data from sources like [RadioReference](https://www.radioreference.com/db/browse/). The CSV should follow this format:

```csv
Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category
9999,,145.190MHz,,HAM,,
4150,1036,AlamanceCo Help,D,County Help,Emergency Ops,Alamance County
```

Fields explained:
- `Decimal`: The numeric Talkgroup ID (required)
- `Hex`: Hexadecimal representation of the TGID (optional)
- `Alpha Tag`: Short identifier for the talkgroup
- `Mode`: Mode of operation (e.g., "D" for digital)
- `Description`: Detailed description of the talkgroup's purpose
- `Tag`: Additional categorization or tagging
- `Category`: Primary category grouping

The system will automatically:
- Load and parse the CSV on startup
- Upsert records into MongoDB for persistence
- Maintain an in-memory cache for quick lookups
- Display friendly names by combining Alpha Tag and Description when available
- Fall back to "TGID {number}" if no friendly name exists
- Enable filtering and grouping based on Category and Tag fields

This metadata system works in conjunction with the talkgroup ranges defined in your `.env` file. While the `.env` file defines the broad group ranges (e.g., HAM=9960-9999), the CSV provides detailed information about specific talkgroups within those ranges.

### 4. Start MongoDB

Ensure your local or remote MongoDB is running:
```bash
systemctl start mongod
# or "mongod --config /etc/mongod.conf"
```

### 5. Run

```bash
npm start
```

This will launch the server on [http://localhost:3000](http://localhost:3000) (or your `PORT` if set).

---

## Usage

### Uploading New Transcriptions
- Via `POST /api/upload` with an `X-API-Key`. Multer handles the `.mp3` and transcription text.  
- On success, the server caches it, broadcasts it to listening WebSocket clients.

### Autoplay & Real-Time
- Clients can enable Auto-Play Audio. Each new transcription might queue `.mp3` paths if it matches your group filter.  
- The user sees new lines in the feed, or they can filter by group in the nav.

### Loading Older Messages
- Scrolling down and clicking "Load More" calls `GET /api/transcriptions?before=<timestamp>`.  
- The server returns older transcriptions with timestamps `< before`, appended dynamically.

### Using AI Analysis
- Navigate to the LLM tab in the navigation
- Select your preferred AI service (OpenAI/Google) and model
- Set the date range for analysis
- Enter your API key (never stored, used only for your session)
- Submit your query to analyze transcriptions

### Theme Customization
- Click the Theme dropdown in the navigation
- Select from available themes:
  - Light/Dark for standard usage
  - Ultra Dark for night viewing
  - Color Psychology for enhanced readability
  - Vibrant Sunrise/Serene Ocean for unique aesthetics
  - Intelligence Agency for a professional look
- Theme preference is saved locally

---

## Contributing

1. Fork & Branch  
2. Make changes, add tests or docs.  
3. Submit a Pull Request describing your changes.
```
