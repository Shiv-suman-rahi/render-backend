# YouTube Watch Party System — Backend

A real-time backend service for the **YouTube Watch Party System**, a web application designed to let multiple users join a shared room and watch YouTube videos together.

The backend provides HTTP APIs, room-related operations, and real-time communication using Node.js, Express.js, and Socket.IO. It is designed to work with a separately deployed frontend.

## Overview

The YouTube Watch Party System aims to make watching YouTube videos with friends easier by allowing users to create or join a shared room and synchronize playback.

This repository contains the backend responsible for handling client requests and coordinating communication between connected participants.

**Backend repository:** [render-backend](https://github.com/Shiv-suman-rahi/render-backend)
**Frontend repository:** [versel-frontend](https://github.com/Shiv-suman-rahi/versel-frontend)
**Live frontend:** [YouTube Watch Party System](https://vercel-frontend-lkjj.vercel.app/)

> **Note:** Replace or correct the frontend repository link if its actual GitHub name differs.

## Features

* **Room Management:** Supports room creation and joining, subject to the implemented backend routes and event handlers.
* **Room Codes:** Uses room identifiers to help participants access shared watch rooms.
* **Real-Time Communication:** Uses Socket.IO for event-based communication between the server and connected clients.
* **Playback Synchronization:** Supports synchronization-related events where implemented in the server and frontend.
* **REST API:** Provides HTTP endpoints for frontend-backend communication.
* **Frontend Integration:** Designed to communicate with a separately deployed frontend.
* **Cloud Deployment:** Backend deployment is configured through Render.

**Implementation note:** Persistent user accounts, authentication, authorization, and database-backed room history should only be listed as available features after the corresponding functionality has been implemented and tested.

## Technology Stack

| Technology     | Purpose                                 |
| -------------- | --------------------------------------- |
| Node.js        | JavaScript runtime for the backend      |
| Express.js     | HTTP server and API routing             |
| Socket.IO      | Real-time, event-based communication    |
| MongoDB        | Database integration, where configured  |
| Mongoose       | MongoDB object modeling, if used        |
| Git and GitHub | Version control and source-code hosting |
| Render         | Backend hosting                         |

## Project Structure

The following is an illustrative structure. Confirm the actual files and folders in the repository before treating it as an exact directory listing.

```text
render-backend/
├── src/
│   └── server.js
├── scripts/
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

The application entry point, room-management modules, database models, and utility files may vary according to the current implementation.

## How It Works

The general client-server flow is:

1. A user opens the frontend application.
2. The frontend sends an HTTP request or establishes a Socket.IO connection to the backend.
3. The backend validates and processes the incoming request or event.
4. For room-related operations, the backend handles the relevant room logic.
5. Connected participants receive real-time updates when the corresponding events are implemented.
6. The frontend updates the room interface and video player based on the received information.

### HTTP and Real-Time Communication

**HTTP / REST API:** Used for request-response operations such as room-related API calls.

**Socket.IO:** Used for event-based communication, allowing the server and connected clients to exchange updates without repeatedly polling an HTTP endpoint.

Socket.IO can use WebSocket as its transport and can fall back to HTTP long-polling when appropriate. It is not limited to WebSocket in every connection.

### Room State and Persistence

The backend's room-management implementation should be documented according to how state is stored.

If `RoomManager` uses an in-memory JavaScript `Map`, that room state exists in the running Node.js process and is not automatically persisted to MongoDB. Such state can be lost when the process restarts.

MongoDB persistence should only be claimed for the specific data that is actually saved through database models and operations.

## Prerequisites

Before running the backend locally, install:

* [Node.js](https://nodejs.org/)
* npm, included with Node.js
* [Git](https://git-scm.com/)
* MongoDB connection details, if required by the application

## Installation and Setup

### 1. Clone the Repository

```bash
git clone https://github.com/Shiv-suman-rahi/render-backend.git
cd render-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root if the application uses environment variables.

Example configuration:

```env
PORT=3000
MONGODB_URI=your_mongodb_connection_string
MONGODB_DB=watch_party
CLIENT_URL=https://your-frontend.vercel.app
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=Watch Party <verified-sender@example.com>
```

Email verification is required before account creation. Configure SMTP credentials and a verified sender address in Render's environment settings (and in `.env` for local development). `SMTP_SECURE` is optional; port 465 enables TLS automatically, while port 587 uses STARTTLS. Signup email delivery returns an error if SMTP is not configured or delivery fails; it never creates an unverified account.

For Gmail SMTP, set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` to the full Gmail address, and `SMTP_PASS` to a Google App Password generated after enabling 2-Step Verification. Do not use the normal Gmail account password. Set `SMTP_FROM` to that same Gmail address or another sender authorized by the account. Configure the values both in the local backend `.env` and in Render's backend environment; local values are not deployed.

Signup codes are six digits, expire after 10 minutes, and allow at most five incorrect attempts. Pending signup records are stored temporarily in `pendingsignups` and removed after verification or expiration.

Never commit `.env` files, database credentials, authentication secrets, or other sensitive configuration to GitHub.

### 4. Start the Backend

Use the command defined in `package.json`.

For example, if a development script is available:

```bash
npm run dev
```

For production, use the actual start script defined by the project:

```bash
npm start
```

These commands work only if the corresponding scripts are configured in `package.json`.

### 5. Verify the Server

After starting the backend, check the terminal output for successful startup.

If a health-check endpoint is implemented, open its configured URL to verify that the server responds. Otherwise, test an existing API endpoint using a browser or an API client such as Postman.

## Deployment on Render

The backend is intended to run as a deployed web service on Render.

General deployment procedure:

1. Sign in to [Render](https://render.com/).
2. Create a new Web Service.
3. Connect the `render-backend` GitHub repository.
4. Configure the build command according to the project, commonly `npm install`.
5. Set the start command to the production script defined in `package.json`.
6. Add the required environment variables through the Render dashboard.
7. Deploy the service and review its logs.
8. Test the deployed API and Socket.IO connection.

Use the actual public Render service URL when configuring the frontend. The URL and available endpoints should be documented after verifying the deployed service.

## Frontend Integration

The backend and frontend must be configured to communicate with each other.

For deployment:

* Configure the frontend to use the deployed backend URL instead of a local URL such as `http://localhost:3000`.
* Configure Express CORS to permit requests from the intended frontend origin.
* Configure Socket.IO CORS separately where required.
* Use HTTPS for production HTTP requests and secure transport for real-time connections.
* Ensure that any credentials or authentication tokens are handled according to the application's security design.

If the frontend is deployed on Vercel and the backend on Render, verify that both deployments use the correct production URLs and environment variables.

## Security Considerations

* Store credentials and secrets in environment variables.
* Restrict CORS to trusted origins in production.
* Validate request bodies, query parameters, room identifiers, and other user input.
* Handle invalid requests and unexpected server errors safely.
* Apply authentication and authorization to protected operations if supported.
* Avoid exposing database credentials or internal server details in API responses.
* Use HTTPS in production.
* Configure appropriate access controls before introducing persistent user accounts or private rooms.

## Troubleshooting

### Frontend Still Uses the Local Backend

Check the frontend's API base URL and Socket.IO connection URL. Confirm that the production environment variables point to the deployed backend, then rebuild and redeploy the frontend.

### CORS Errors

Verify that the deployed frontend origin is included in the backend's CORS configuration. Check the Socket.IO server configuration separately.

### MongoDB Connection Failure

Verify the connection string, database access permissions, network access settings, and the backend's environment variables.

### Room State Is Lost After Restart

If room state is stored only in an in-memory `Map`, a server restart clears that state. Persistent room storage requires an appropriate database implementation.

### Socket.IO Connection Failure

Check the deployed server URL, client connection configuration, CORS settings, and server logs. Confirm that the backend and frontend agree on the event names and payload formats.

## Future Improvements

Potential enhancements, depending on the current implementation, include:

* User registration, login, and secure authentication.
* Persistent user profiles using MongoDB.
* Database-backed room history and saved preferences.
* Stronger room access controls and participant permissions.
* Improved reconnect handling and playback-state recovery.
* Automated tests for API endpoints and Socket.IO events.
* API documentation and structured server logging.

These items are suggestions for future development, not claims that the features are already implemented.

## Author

**Shiv Suman Rahi**

B.Tech — Computer Science (Data Science)

* GitHub: [Shiv-suman-rahi](https://github.com/Shiv-suman-rahi)
* Project: YouTube Watch Party System

---

*Built as a full-stack development project to explore backend APIs, real-time communication, room management, and cloud deployment.*
