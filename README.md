# YouTube Watch Party System — Backend

A backend service for the **YouTube Watch Party System**, a web application designed to let users create or join watch rooms and enjoy YouTube videos together.

The backend handles server-side operations, room management, client-server communication, and database integration. It is designed to work with the separately deployed frontend.

## 🚀 Project Overview

The YouTube Watch Party System aims to provide a shared video-watching experience where users can join a common room and watch YouTube videos together.

This repository contains the backend application responsible for processing requests from the frontend and supporting the application's room-based functionality.

## ✨ Key Features

* **Room Management:** Supports creating and joining watch rooms.
* **Unique Room Codes:** Enables users to identify and access specific rooms.
* **Real-Time Communication:** Supports synchronized communication between connected participants through Socket.IO, where implemented.
* **REST API:** Provides HTTP endpoints for frontend-backend communication.
* **Database Integration:** Supports persistent storage through MongoDB, when configured.
* **Frontend Integration:** Designed to communicate with the separately deployed frontend.
* **Cloud Deployment:** Backend hosted on Render.

## 🛠️ Tech Stack

* **Runtime:** Node.js
* **Backend Framework:** Express.js
* **Real-Time Communication:** Socket.IO
* **Database:** MongoDB
* **Database ODM:** Mongoose, if used in the application
* **Deployment:** Render
* **Version Control:** Git and GitHub

## 📁 Project Structure

```text
render-backend/
├── src/
│   └── server.js        # Application entry point, if configured here
├── scripts/             # Utility and project scripts
├── package.json         # Dependencies and npm scripts
├── package-lock.json    # Dependency lock file
├── .gitignore           # Git exclusion rules
└── README.md            # Project documentation
```

The exact files and responsibilities may vary according to the current implementation.

## ⚙️ Getting Started

### 1. Prerequisites

Install the following before running the project:

* Node.js and npm
* Git
* MongoDB connection string, if database integration is enabled

### 2. Clone the Repository

```bash
git clone https://github.com/Shiv-suman-rahi/render-backend.git
cd render-backend
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Create a `.env` file in the project root and configure the variables required by your application.

Example:

```env
PORT=3000
MONGODB_URI=your_mongodb_connection_string
FRONTEND_URL=https://vercel-frontend-lkjj.vercel.app
```

Use the exact environment-variable names expected by your source code. If the project uses a different variable name for the database URI or frontend origin, update the example accordingly.

**Important:** Never commit your `.env` file, database credentials, or other secrets to GitHub.

### 5. Run the Backend

Use the script defined in `package.json`. For example:

```bash
npm run dev
```

If a development script is not configured, check the available scripts in `package.json` and use the appropriate command.

Once the server starts, it should listen on the configured port.

## 🌐 Deployment on Render

The backend can be deployed using Render.

1. Sign in to your Render account.
2. Create a new Web Service.
3. Connect your GitHub repository: `Shiv-suman-rahi/render-backend`.
4. Configure the build command as `npm install`.
5. Configure the start command according to the scripts in `package.json`, such as `npm start`, if available.
6. Add the required environment variables in Render's environment settings.
7. Deploy the service and verify that the server starts successfully.

Use Render's assigned public URL when configuring the frontend.

## 🔗 Frontend Integration

The backend is intended to work with the separately deployed frontend.

* **Frontend repository:** [versel-frontend](https://github.com/Shiv-suman-rahi/versel-frontend)
* **Live frontend:** [YouTube Watch Party System](https://vercel-frontend-lkjj.vercel.app/)
* **Backend repository:** [render-backend](https://github.com/Shiv-suman-rahi/render-backend)
* **Backend hosting:** Render

For successful integration, configure the frontend to use the deployed backend URL instead of a local development URL such as `http://localhost:3000`.

Ensure that CORS allows requests from the deployed frontend origin. If Socket.IO is used, configure its CORS settings as well.

## 🔒 Security Considerations

* Keep database credentials and secrets in environment variables.
* Restrict CORS to trusted frontend origins in production.
* Validate incoming requests and room-related input.
* Avoid exposing sensitive server configuration in API responses.
* Use HTTPS for production communication.

## 🎯 Project Objective

The objective of this project is to build a backend that supports an interactive, room-based YouTube watching experience using modern web development technologies and cloud deployment.

## 👨‍💻 Author

**Shiv Suman Rahi**

B.Tech — Computer Science (Data Science)

GitHub: [Shiv-suman-rahi](https://github.com/Shiv-suman-rahi)

---

*Part of the YouTube Watch Party System project.*
