let stagedSongs = [];
let draggedSongId = null;

const addSongButton =
  document.querySelector("#add-song");

const urlInput =
  document.querySelector("#new-youtube-url");

const songList =
  document.querySelector("#song-list");

const fetchStatus =
  document.querySelector("#fetch-status");

const convertButton =
  document.querySelector("#convert");

const conversionStatus =
  document.querySelector("#conversion-status");

addSongButton.addEventListener("click", addSong);

urlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addSong();
  }
});

async function addSong() {
  const url = urlInput.value.trim();

  if (!url) {
    fetchStatus.textContent = "Paste a YouTube link.";
    return;
  }

  addSongButton.disabled = true;
  urlInput.disabled = true;
  fetchStatus.textContent =
    "Fetching song information…";

  try {
    const info =
      await window.desktopAPI.fetchYouTubeInfo(url);

    const duplicate = stagedSongs.some(
      (song) => song.videoId === info.id
    );

    if (duplicate) {
      fetchStatus.textContent =
        "That song is already staged.";
      return;
    }

    stagedSongs.push({
      id: crypto.randomUUID(),
      videoId: info.id,
      url: info.url,
      sourceName: info.title,
      outputTitle: info.title
    });

    urlInput.value = "";
    fetchStatus.textContent = "Song added.";

    renderSongList();
  } catch (error) {
    console.error(error);

    fetchStatus.textContent =
      `Could not fetch song: ${error.message}`;
  } finally {
    addSongButton.disabled = false;
    urlInput.disabled = false;
    urlInput.focus();
  }
}

function renderSongList() {
  songList.replaceChildren();

  if (stagedSongs.length === 0) {
    const empty = document.createElement("div");

    empty.className = "empty-list";
    empty.textContent = "No songs added";

    songList.append(empty);
    convertButton.disabled = true;
    return;
  }

  convertButton.disabled = false;

  stagedSongs.forEach((song, index) => {
    const row = document.createElement("div");

    row.className = "song-row";
    row.draggable = true;
    row.dataset.songId = song.id;

    row.addEventListener("dragstart", (event) => {
      draggedSongId = song.id;
      row.classList.add("dragging");

      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(
        "text/plain",
        song.id
      );
    });

    row.addEventListener("dragend", () => {
      draggedSongId = null;
      row.classList.remove("dragging");
    });

    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });

    row.addEventListener("drop", (event) => {
      event.preventDefault();

      const sourceId =
        draggedSongId ||
        event.dataTransfer.getData("text/plain");

      reorderSong(sourceId, song.id);
    });

    const details = document.createElement("div");
    details.className = "song-details";

    const source = document.createElement("div");
    source.className = "song-source";
    source.textContent =
      `${index + 1}. ${song.sourceName}`;
    source.title = song.url;

    const titleInput =
      document.createElement("input");

    titleInput.className = "song-title";
    titleInput.type = "text";
    titleInput.value = song.outputTitle;
    titleInput.placeholder = "Desired output title";
    titleInput.maxLength = 120;

    titleInput.addEventListener("input", () => {
      song.outputTitle = titleInput.value;
    });

    const controls = document.createElement("div");
    controls.className = "song-controls";

    const handle = document.createElement("div");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";

    const removeButton =
      document.createElement("button");

    removeButton.className = "remove-song";
    removeButton.type = "button";
    removeButton.textContent = "×";
    removeButton.title = "Remove song";

    removeButton.setAttribute(
      "aria-label",
      `Remove ${song.sourceName}`
    );

    removeButton.addEventListener("click", () => {
      stagedSongs = stagedSongs.filter(
        (item) => item.id !== song.id
      );

      renderSongList();
    });

    details.append(source, titleInput);
    controls.append(handle, removeButton);
    row.append(details, controls);
    songList.append(row);
  });
}

function reorderSong(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) {
    return;
  }

  const sourceIndex = stagedSongs.findIndex(
    (song) => song.id === sourceId
  );

  const targetIndex = stagedSongs.findIndex(
    (song) => song.id === targetId
  );

  if (sourceIndex === -1 || targetIndex === -1) {
    return;
  }

  const [movedSong] = stagedSongs.splice(
    sourceIndex,
    1
  );

  stagedSongs.splice(targetIndex, 0, movedSong);

  renderSongList();
}

convertButton.addEventListener("click", async () => {
  if (stagedSongs.length === 0) {
    conversionStatus.textContent =
      "Add at least one song.";
    return;
  }

  const invalidTitle = stagedSongs.find(
    (song) => !song.outputTitle.trim()
  );

  if (invalidTitle) {
    conversionStatus.textContent =
      "Every song needs an output title.";
    return;
  }

  const folderName = document
    .querySelector("#folder-name")
    .value
    .trim();

  const semitones = Number(
    document.querySelector("#pitch").value
  );

  const speedPercent = Number(
    document.querySelector("#speed").value
  );

  convertButton.disabled = true;
  addSongButton.disabled = true;
  urlInput.disabled = true;

  conversionStatus.textContent =
    "Downloading and converting staged songs…";

  try {
    const result =
      await window.desktopAPI.downloadQueue({
        songs: stagedSongs.map((song) => ({
          url: song.url,
          outputTitle: song.outputTitle.trim()
        })),
        folderName,
        semitones,
        speedPercent
      });

    conversionStatus.textContent =
      `Saved ${result.files.length} song(s) to ` +
      `${result.folderPath}.`;
  } catch (error) {
    console.error(error);

    conversionStatus.textContent =
      `Conversion failed: ${error.message}`;
  } finally {
    convertButton.disabled = false;
    addSongButton.disabled = false;
    urlInput.disabled = false;
  }
});

renderSongList();