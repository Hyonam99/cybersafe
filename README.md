# CyberSafe NG

An offline-first cybersecurity awareness platform for Nigerian secondary school students. It teaches three modules (Cyberbullying, Online Grooming and Phishing) through short lessons, scenario questions and quizzes, with badges for students and progress reports for teachers.

## How it works

- **Database:** SQLite, run in the browser through [sql.js](https://sql.js.org) (SQLite compiled to WebAssembly). The database file is saved on the device in IndexedDB, so progress survives reloads and the app keeps working without internet.
- **First run:** the database is created and filled from `data/seed.json` (modules, lessons, quiz bank, badges, a demo school, demo accounts and a sample class).
- **Offline:** a service worker (`sw.js`) keeps a copy of the app on the device after the first visit.
- **Local server:** `server.js` serves the app from one computer to every device on the school network, with no internet connection.
- **Code layout:** `js/db.js` (schema and storage), `js/services/*.js` (authentication, content, quiz engine, progress and badges, teacher and admin functions), `js/app.js` (screens and routing).

Each device keeps its own database. Syncing devices to a central school server is future work.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
npm start
```

Open the address it prints. Other computers on the same network can use the "school network" address.

Run the tests with `npm test`.

## Deploy

The app is a static site. On Netlify or Vercel, deploy this folder with no build command (`netlify.toml` and `vercel.json` are included). Each visitor gets their own copy of the database in their browser.

## Demo accounts

All demo accounts use the password `CyberSafe2026`.

| Role | Username |
|---|---|
| Administrator | `admin` |
| Teacher | `teacher` |
| Student (JSS2 Gold) | `student` |

Join codes for testing registration: `KPX7QM` (JSS2 Gold) and `R4T9WN` (SS1 Science).

Use **Reset data** in the page footer to return to the seed data.
