const {
  app,
  BrowserWindow,
  ipcMain,
  Menu
} = require("electron");

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const discordRpc = require('discord-rpc');

const ffmpegPath = require("ffmpeg-static");

const { create: createYoutubeDl } =
  require("youtube-dl-exec");

const ytDlpPath = app.isPackaged
  ? path.join(
      process.resourcesPath,
      "bin",
      "yt-dlp.exe"
    )
  : path.join(
      __dirname,
      "bin",
      "yt-dlp.exe"
    );

const youtubedl = createYoutubeDl(ytDlpPath);

const iconPath = path.join(
  __dirname,
  "assets",
  "icon.png"
);

const clientId = '1553625317283995709'; 

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 640,
    minHeight: 520,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const menu = Menu.buildFromTemplate([
  ]);

  mainWindow.loadFile("index.html");

  // mainWindow.webContents.openDevTools();
}

/*
 * Fetch information for one YouTube URL without downloading it.
 */
ipcMain.handle(
  "fetch-youtube-info",
  async (_event, value) => {
    const url = normalizeYouTubeUrl(value);

    if (!url) {
      throw new Error("Enter a valid YouTube URL.");
    }

    const metadata = await youtubedl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      noPlaylist: true,
      noWarnings: true
    });

    return {
      id: String(metadata.id),
      title: sanitizeOutputName(
        metadata.title || "YouTube audio"
      ),
      url:
        normalizeYouTubeUrl(metadata.webpage_url) ||
        url,
      duration: Number(metadata.duration) || null
    };
  }
);

/*
 * Download and convert every staged song in the supplied order.
 */
ipcMain.handle(
  "download-youtube-queue",
  async (_event, options) => {
    const {
      songs,
      folderName,
      semitones,
      speedPercent
    } = options ?? {};

    if (!Array.isArray(songs) || songs.length === 0) {
      throw new Error("No staged songs were supplied.");
    }

    const pitch = Number(semitones);
    const speedPercentage = Number(speedPercent);
    const speed = speedPercentage / 100;

    validateConversionSettings(
      pitch,
      speedPercentage
    );

    const safeFolderName =
      sanitizeOutputName(folderName) ||
      "Converted Audio";

    const outputDirectory = getUniqueDirectoryPath(
      app.getPath("downloads"),
      safeFolderName
    );

    await fsPromises.mkdir(outputDirectory, {
      recursive: false
    });

    const results = [];

    for (const song of songs) {
      const url = normalizeYouTubeUrl(song?.url);

      if (!url) {
        throw new Error(
          "A staged song has an invalid YouTube URL."
        );
      }

      const outputTitle = sanitizeOutputName(
        song?.outputTitle
      );

      if (!outputTitle) {
        throw new Error(
          "Every song needs a valid output title."
        );
      }

      const tempDirectory =
        await fsPromises.mkdtemp(
          path.join(os.tmpdir(), "audio-converter-")
        );

      try {
        const outputTemplate = path.join(
          tempDirectory,
          "source.%(ext)s"
        );

        console.log("Downloading:", url);
        console.log(
          "Temporary directory:",
          tempDirectory
        );

        /*
         * Do not use dumpSingleJson here. It is used only by the
         * metadata handler above. The fixed source filename makes
         * locating the downloaded stream reliable.
         */
        await youtubedl(url, {
          noPlaylist: true,
          noWarnings: true,
          format: "bestaudio/best",
          output: outputTemplate,
          ffmpegLocation: ffmpegPath
        });

        const downloadedFiles =
          await fsPromises.readdir(tempDirectory);

        console.log(
          "Files downloaded by yt-dlp:",
          downloadedFiles
        );

        const downloadedName =
          downloadedFiles.find((filename) => {
            const lowerName =
              filename.toLowerCase();

            return (
              filename.startsWith("source.") &&
              !lowerName.endsWith(".part") &&
              !lowerName.endsWith(".ytdl") &&
              !lowerName.endsWith(".json")
            );
          });

        if (!downloadedName) {
          throw new Error(
            `Could not locate the downloaded audio for ` +
            `"${outputTitle}". Temporary files: ` +
            `${downloadedFiles.join(", ") || "none"}`
          );
        }

        const inputPath = path.join(
          tempDirectory,
          downloadedName
        );

        const outputPath = getUniquePath(
          outputDirectory,
          outputTitle,
          ".mp3"
        );

        await convertUnder20MB({
          inputPath,
          outputPath,
          semitones: pitch,
          speed
        });

        results.push(outputPath);
      } finally {
        await fsPromises.rm(tempDirectory, {
          recursive: true,
          force: true
        });
      }
    }

    return {
      folderPath: outputDirectory,
      files: results
    };
  }
);

function validateConversionSettings(
  pitch,
  speedPercentage
) {
  if (!Number.isFinite(pitch)) {
    throw new Error("Pitch must be a valid number.");
  }

  if (pitch < -24 || pitch > 24) {
    throw new Error(
      "Pitch must be between -24 and 24 semitones."
    );
  }

  if (!Number.isFinite(speedPercentage)) {
    throw new Error("Speed must be a valid number.");
  }

  if (
    speedPercentage < 25 ||
    speedPercentage > 400
  ) {
    throw new Error(
      "Speed must be between 25% and 400%."
    );
  }
}

/*
 * Retry with progressively lower MP3 bitrates until the output
 * is strictly smaller than 20 MiB.
 */
async function convertUnder20MB(options) {
  const bitrates = [
    192,
    160,
    128,
    112,
    96,
    80,
    64,
    48,
    40,
    32
  ];

  for (const bitrate of bitrates) {
    await convertFile({
      ...options,
      bitrate
    });

    const stats = await fsPromises.stat(
      options.outputPath
    );

    const sizeMB = stats.size / 1024 / 1024;

    console.log(
      `Created "${options.outputPath}" at ` +
      `${bitrate} kbps (${sizeMB.toFixed(2)} MiB)`
    );

    if (stats.size < MAX_OUTPUT_BYTES) {
      return;
    }

    await fsPromises
      .unlink(options.outputPath)
      .catch(() => {});
  }

  throw new Error(
    "An output could not be compressed below 20 MB."
  );
}

/*
 * Independently adjust pitch and speed.
 *
 * asetrate changes pitch and tempo together. atempo then
 * compensates so that the final speed matches the requested value.
 */
function convertFile({
  inputPath,
  outputPath,
  semitones,
  speed,
  bitrate
}) {
  return new Promise((resolve, reject) => {
    const pitchFactor =
      2 ** (semitones / 12);

    const tempoCompensation =
      speed / pitchFactor;

    if (
      !Number.isFinite(pitchFactor) ||
      pitchFactor <= 0 ||
      !Number.isFinite(tempoCompensation) ||
      tempoCompensation <= 0
    ) {
      reject(
        new Error("Invalid pitch or speed setting.")
      );

      return;
    }

    const filters = [
      `asetrate=48000*${pitchFactor}`,
      "aresample=48000",
      ...createAtempoFilters(
        tempoCompensation
      )
    ];

    const args = [
      "-hide_banner",
      "-y",
      "-i",
      inputPath,

      // Audio only
      "-vn",

      // Remove source metadata and chapters
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",

      // Pitch and tempo
      "-af",
      filters.join(","),

      // MP3 encoding
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${bitrate}k`,

      // Prevent ID3v1 and ID3v2 metadata
      "-id3v2_version",
      "0",
      "-write_id3v1",
      "0",

      outputPath
    ];

    console.log(
      "FFmpeg executable:",
      ffmpegPath
    );

    console.log(
      "FFmpeg arguments:",
      args.join(" ")
    );

    const child = spawn(ffmpegPath, args, {
      windowsHide: true
    });

    let stderr = "";
    let settled = false;

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;

      reject(
        new Error(
          `Could not start FFmpeg: ${error.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `FFmpeg exited with code ${code}:\n${stderr}`
        )
      );
    });
  });
}

/*
 * Keep each atempo stage between 0.5 and 2 for broad FFmpeg
 * compatibility.
 */
function createAtempoFilters(tempo) {
  const filters = [];
  let remaining = tempo;

  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }

  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }

  if (Math.abs(remaining - 1) > 0.000001) {
    filters.push(`atempo=${remaining}`);
  }

  return filters;
}

function getUniquePath(
  directory,
  filename,
  extension
) {
  let outputPath = path.join(
    directory,
    `${filename}${extension}`
  );

  let number = 1;

  while (fs.existsSync(outputPath)) {
    outputPath = path.join(
      directory,
      `${filename} (${number})${extension}`
    );

    number += 1;
  }

  return outputPath;
}

function getUniqueDirectoryPath(
  parentDirectory,
  folderName
) {
  let directoryPath = path.join(
    parentDirectory,
    folderName
  );

  let number = 1;

  while (fs.existsSync(directoryPath)) {
    directoryPath = path.join(
      parentDirectory,
      `${folderName} (${number})`
    );

    number += 1;
  }

  return directoryPath;
}

/*
 * Remove characters that are invalid in common Windows/macOS
 * filenames and remove problematic trailing periods and spaces.
 */
function sanitizeOutputName(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
}

/*
 * Accept standard HTTPS YouTube URLs only. Playlist parameters are
 * removed, and playlist downloading is also disabled in yt-dlp.
 */
function normalizeYouTubeUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = new URL(value.trim());

    if (parsed.protocol !== "https:") {
      return null;
    }

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/\.$/, "");

    const allowedHosts = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ]);

    if (!allowedHosts.has(hostname)) {
      return null;
    }

    parsed.searchParams.delete("list");
    parsed.searchParams.delete("index");
    parsed.searchParams.delete("start_radio");

    return parsed.toString();
  } catch {
    return null;
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (
      BrowserWindow.getAllWindows().length === 0
    ) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    rpc.destroy();
  }
});

// discord rpc l

const rpc = new discordRpc.Client({ transport: 'ipc' });

async function setActivity() {
  if (!rpc || !mainWindow) return;

  // Update the presence status
  rpc.setActivity({
    details: 'Creating in Studio',       // Line 2
    //state: '',                 // Line 3
    startTimestamp: new Date(),          // Shows elapsed time
    largeImageKey: 'logo',         // Must match asset name in developer portal
    largeImageText: 'Zenshi',    // Tooltip text
    smallImageKey: 'status_active',      // Small badge asset name
    smallImageText: 'Active',
    instance: false,
    // buttons: [                           // Clickable links (max 2)
    //   { label: 'Visit Website', url: 'https://example.com' },
    //   { label: 'Join Discord', url: 'https://discord.gg' }
    // ]
  });
}

// Trigger RPC login when the client is ready
rpc.on('ready', () => {
  console.log('Discord RPC connected.');
  setActivity();
  
  // Optional: Update activity periodically (e.g., every 15 seconds)
  setInterval(() => {
    setActivity();
  }, 15000);
});

// Log into Discord
rpc.login({ clientId }).catch(console.error);
