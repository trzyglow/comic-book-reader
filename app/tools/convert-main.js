const { app, BrowserWindow, ipcMain } = require("electron");

const fs = require("fs");
const path = require("path");
const FileType = require("file-type");
const fileUtils = require("../file-utils");
const mainProcess = require("../main");

let g_convertWindow;

function isDev() {
  return process.argv[2] == "--dev";
}

function _(...args) {
  return mainProcess.i18n_.apply(null, args);
}

exports.showWindow = function (parentWindow, filePath, fileType) {
  if (g_convertWindow !== undefined) return; // TODO: focus the existing one?
  g_convertWindow = new BrowserWindow({
    width: 700,
    height: 650,
    //frame: false,
    icon: path.join(__dirname, "../assets/images/icon_256x256.png"),
    resizable: true,
    backgroundColor: "white",
    parent: parentWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
    },
  });

  g_convertWindow.menuBarVisible = false;
  g_convertWindow.loadFile(`${__dirname}/convert.html`);

  g_convertWindow.on("closed", () => {
    g_convertWindow = undefined;
  });

  g_convertWindow.webContents.on("did-finish-load", function () {
    g_convertWindow.webContents.send(
      "update-localization",
      _("Convert Files Tool"),
      getLocalization(),
      getTooltipsLocalization()
    );
    if (filePath === undefined) {
      g_convertWindow.webContents.send("set-mode", 1, app.getPath("desktop"));
    } else {
      g_convertWindow.webContents.send("set-mode", 0, path.dirname(filePath));
      g_convertWindow.webContents.send("add-file", filePath, fileType);
    }
  });

  //if (isDev()) g_convertWindow.toggleDevTools();
};

///////////////////////////////////////////////////////////////////////////////

ipcMain.on("convert-choose-file", (event) => {
  let fileList = fileUtils.chooseFile(g_convertWindow);
  if (fileList === undefined) {
    return;
  }
  let filePath = fileList[0];
  let fileType;

  // mostly a COPY FROM main, maybe make a common function in file.utils
  let fileExtension = path.extname(filePath).toLowerCase();
  (async () => {
    let _fileType = await FileType.fromFile(filePath);
    if (_fileType !== undefined) {
      fileExtension = "." + _fileType.ext;
    }
    if (fileExtension === ".pdf") {
      fileType = "pdf";
    } else if (fileExtension === ".epub") {
      fileType = "epub";
    } else {
      if (fileExtension === ".rar" || fileExtension === ".cbr") {
        fileType = "rar";
      } else if (fileExtension === ".zip" || fileExtension === ".cbz") {
        fileType = "zip";
      } else {
        return;
      }
    }
    g_convertWindow.webContents.send("add-file", filePath, fileType);
  })();
});

ipcMain.on("convert-choose-folder", (event) => {
  let folderList = fileUtils.chooseFolder(g_convertWindow);
  if (folderList === undefined) {
    return;
  }
  let folderPath = folderList[0];
  //console.log("select folder request:" + folderPath);
  if (folderPath === undefined || folderPath === "") return;

  g_convertWindow.webContents.send("change-output-folder", folderPath);
});

/////////////////////////

ipcMain.on(
  "convert-start-conversion",
  (event, inputFilePath, inputFileType) => {
    conversionStart(inputFilePath, inputFileType);
  }
);

ipcMain.on("convert-stop-error", (event, ee) => {
  conversionStopError(err);
});

ipcMain.on("convert-pdf-images-extracted", (event) => {
  g_convertWindow.webContents.send("convert-images-extracted");
});

ipcMain.on(
  "convert-create-file-from-images",
  (
    event,
    inputFilePath,
    outputScale,
    outputQuality,
    outputFormat,
    outputFolderPath
  ) => {
    createFileFromImages(
      inputFilePath,
      outputScale,
      outputQuality,
      outputFormat,
      outputFolderPath
    );
  }
);

///////////////////////////////////////////////////////////////////////////////

function conversionStopError(err) {
  console.log(err);
  g_convertWindow.webContents.send(
    "convert-update-text-title",
    _("Conversion Failed:")
  );
  g_convertWindow.webContents.send("convert-update-text-log", "");
  g_convertWindow.webContents.send(
    "convert-update-text-info",
    _("Couldn't convert the file, an error ocurred")
  );
  g_convertWindow.webContents.send("convert-finished-error");
}

function conversionStart(inputFilePath, inputFileType) {
  g_convertWindow.webContents.send(
    "convert-update-text-title",
    _("Converting:")
  );
  g_convertWindow.webContents.send("convert-update-text-info", inputFilePath);
  g_convertWindow.webContents.send("convert-update-text-log", "");

  // extract to temp folder
  if (
    inputFileType === "zip" ||
    inputFileType === "rar" ||
    inputFileType === "epub"
  ) {
    g_convertWindow.webContents.send(
      "convert-update-text-log",
      _("Extracting Pages...")
    );
    tempFolder = conversionExtractImages(inputFilePath, inputFileType);
  } else if (inputFileType === "pdf") {
    g_convertWindow.webContents.send(
      "convert-update-text-log",
      _("Extracting Pages...")
    );
    tempFolder = fileUtils.createTempFolder();
    g_convertWindow.webContents.send("convert-extract-pdf-images", tempFolder);
  } else {
    conversionStopError("");
  }
}

async function conversionExtractImages(inputFilePath, inputFileType) {
  try {
    if (inputFileType === "zip") {
      fileUtils.extractZip(inputFilePath);
    } else if (inputFileType === "rar") {
      fileUtils.extractRar(inputFilePath);
    } else if (inputFileType === "epub") {
      await fileUtils.extractEpubImages(inputFilePath);
    }
    g_convertWindow.webContents.send("convert-images-extracted");
  } catch (err) {
    conversionStopError(err);
  }
}

async function createFileFromImages(
  inputFilePath,
  outputScale,
  outputQuality,
  outputFormat,
  outputFolderPath
) {
  try {
    let tempFolder = fileUtils.getTempFolder();
    let imgFiles = fileUtils.getImageFilesInFolderRecursive(tempFolder);
    if (imgFiles === undefined || imgFiles.length === 0) {
      conversionStopError("");
      return;
    }

    // resize imgs if needed
    outputScale = parseInt(outputScale);
    outputQuality = parseInt(outputQuality);
    if (outputScale < 100) {
      // ref: https://www.npmjs.com/package/jimp
      const Jimp = require("jimp");
      for (let index = 0; index < imgFiles.length; index++) {
        g_convertWindow.webContents.send(
          "convert-update-text-log",
          _("Resizing Page: ") + (index + 1) + " / " + imgFiles.length
        );
        let image = await Jimp.read(imgFiles[index]);
        image.scale(outputScale / 100);
        image.quality(outputQuality);
        await image.writeAsync(imgFiles[index]);
      }
    }

    // compress to output folder
    g_convertWindow.webContents.send(
      "convert-update-text-log",
      _("Generating New File...")
    );
    let filename = path.basename(inputFilePath, path.extname(inputFilePath));
    let outputFilePath = path.join(
      outputFolderPath,
      filename + "." + outputFormat
    );
    let i = 1;
    while (fs.existsSync(outputFilePath)) {
      //console.log("file already exists");
      i++;
      outputFilePath = path.join(
        outputFolderPath,
        filename + "(" + i + ")." + outputFormat
      );
    }

    if (outputFormat === "pdf") {
      fileUtils.createPdfFromImages(imgFiles, outputFilePath);
    } else if (outputFormat === "epub") {
      await fileUtils.createEpubFromImages(imgFiles, outputFilePath);
    } else {
      //cbz
      fileUtils.createZip(imgFiles, outputFilePath);
    }

    // delete temp folder
    g_convertWindow.webContents.send(
      "convert-update-text-log",
      _("Cleaning Up...")
    );

    fileUtils.cleanUpTempFolder();
    g_convertWindow.webContents.send(
      "convert-update-text-title",
      _("New File Correctly Created:")
    );
    g_convertWindow.webContents.send("convert-update-text-log", "");
    g_convertWindow.webContents.send(
      "convert-update-text-info",
      outputFilePath
    );
    g_convertWindow.webContents.send("convert-finished-ok");
  } catch (err) {
    conversionStopError(err);
  }
}

///////////////////////////////////////////////////////////////////////////////
function getTooltipsLocalization() {
  return [
    {
      id: "tooltip-output-size",
      text: _("tooltip-output-size"),
    },
    {
      id: "tooltip-output-folder",
      text: _("tooltip-output-folder"),
    },
  ];
}

function getLocalization() {
  return [
    {
      id: "text-input-files",
      text: _("Input File/s:"),
    },
    {
      id: "text-input-file",
      text: _("Input File:"),
    },
    {
      id: "button-add-file",
      text: _("Add").toUpperCase(),
    },
    {
      id: "text-output-size",
      text: _("Output Size:"),
    },
    {
      id: "text-scale",
      text: _("Scale (%):"),
    },
    {
      id: "text-quality",
      text: _("Quality:"),
    },
    {
      id: "text-output-format",
      text: _("Output Format:"),
    },
    {
      id: "text-output-folder",
      text: _("Output Folder:"),
    },
    {
      id: "button-change-folder",
      text: _("Change").toUpperCase(),
    },
    {
      id: "button-convert",
      text: _("Convert").toUpperCase(),
    },
    {
      id: "button-modal-close",
      text: _("Close").toUpperCase(),
    },
  ];
}