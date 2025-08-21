// src/lib/config/sftp/sftpServer.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "ssh2";
import dotenv from "dotenv";
// Load environment variables from .env file
dotenv.config();

const { Server } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Root folder (configurable via env)
const ROOT = process.env.DATA_DIR || path.join(__dirname, "sftp-root");

// Ensure the root exists
fs.mkdirSync(ROOT, { recursive: true });

// Create standard subfolders
["incoming/products", "incoming/inventory", "incoming/orders"].forEach((sub) => {
  fs.mkdirSync(path.join(ROOT, sub), { recursive: true });
});

// Port and credentials from environment
const PORT = parseInt(process.env.PORT, 10) || 2222;
const USER = process.env.SFTP_USER || "eagle";
const PASS = process.env.SFTP_PASS || "eagle123";

// Host key from environment variable
const HOST_KEY_ENV = process.env.HOST_KEY;
if (!HOST_KEY_ENV) {
  console.error("❌ HOST_KEY environment variable is not set");
  process.exit(1);
}

const HOST_KEY = Buffer.from(HOST_KEY_ENV, "utf-8");

const server = new Server(
  {
    hostKeys: [HOST_KEY],
  },
  (client) => {
    console.log("🔌 Client connected");

    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === USER && ctx.password === PASS) {
        console.log("✅ Auth success");
        ctx.accept();
      } else {
        console.log("❌ Auth failed");
        ctx.reject();
      }
    });

    client.on("ready", () => {
      console.log("🟢 Client ready");

      client.on("session", (accept) => {
        const session = accept();

        session.on("sftp", (accept) => {
          const sftpStream = accept();

          // REALPATH
          sftpStream.on("REALPATH", (reqid, givenPath) => {
            const resolved = path.resolve(ROOT, "." + givenPath);
            sftpStream.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
          });

          // OPENDIR + READDIR
          sftpStream.on("OPENDIR", (reqid, givenPath) => {
            const fsPath = path.resolve(ROOT, "." + givenPath);
            fs.readdir(fsPath, (err, files) => {
              if (err) return sftpStream.status(reqid, 4); // FAILURE
              const handle = Buffer.from("fakehandle");
              sftpStream.handle(reqid, handle);

              sftpStream.on("READDIR", (reqid2, handle2) => {
                if (handle2.toString() !== "fakehandle") return sftpStream.status(reqid2, 4);
                const list = files.map((f) => ({ filename: f, longname: f, attrs: {} }));
                sftpStream.name(reqid2, list);
                sftpStream.status(reqid2, 1); // EOF
              });
            });
          });

          // OPEN
          sftpStream.on("OPEN", (reqid, filename, flags) => {
            const fsPath = path.resolve(ROOT, "." + filename);
            const mode = flags & 3; // read/write
            let fd;
            try {
              fd = mode === 0 ? fs.openSync(fsPath, "r") : fs.openSync(fsPath, "w");
            } catch (e) {
              return sftpStream.status(reqid, 4); // FAILURE
            }
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(fd);
            sftpStream.handle(reqid, handle);
          });

          // READ
          sftpStream.on("READ", (reqid, handle, offset, length) => {
            const fd = handle.readUInt32BE(0);
            const buffer = Buffer.alloc(length);
            fs.read(fd, buffer, 0, length, offset, (err, bytesRead) => {
              if (err) return sftpStream.status(reqid, 4);
              if (bytesRead === 0) return sftpStream.status(reqid, 1); // EOF
              sftpStream.data(reqid, buffer.slice(0, bytesRead));
            });
          });

          // WRITE
          sftpStream.on("WRITE", (reqid, handle, offset, data) => {
            const fd = handle.readUInt32BE(0);
            fs.write(fd, data, 0, data.length, offset, (err) => {
              if (err) return sftpStream.status(reqid, 4);
              sftpStream.status(reqid, 0); // OK
            });
          });

          // CLOSE
          sftpStream.on("CLOSE", (reqid, handle) => {
            const fd = handle.readUInt32BE(0);
            fs.close(fd, (err) => {
              if (err) return sftpStream.status(reqid, 4);
              sftpStream.status(reqid, 0); // OK
            });
          });
        });
      });
    });
  }
);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SFTP Server running on port ${PORT}`);
  console.log(`📂 Root directory: ${ROOT}`);
});
