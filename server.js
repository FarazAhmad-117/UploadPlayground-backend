require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const mongoose = require("mongoose");
const { BlobServiceClient } = require("@azure/storage-blob");
const path = require("path");
const logger = require("morgan");

const app = express();
app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json());
app.use(logger("common"));

// Connect to MongoDB with better error handling
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Enhanced File Schema with more metadata
const FileSchema = new mongoose.Schema({
  filename: String,
  originalName: String,
  url: String,
  size: Number,
  fileType: String,
  uploadDate: { type: Date, default: Date.now },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // For future user association
});

const File = mongoose.model("File", FileSchema);

// Azure Storage configuration with error handling
let containerClient;
try {
  const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING
  );
  containerClient = blobServiceClient.getContainerClient(
    process.env.AZURE_CONTAINER_NAME
  );

  // Create container if it doesn't exist
  containerClient
    .createIfNotExists({ access: "blob" })
    .then(() => console.log("Azure container ready"))
    .catch((err) => console.error("Azure container error:", err));
} catch (err) {
  console.error("Azure Storage configuration error:", err);
  process.exit(1);
}

// File upload handling with Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 50, // Max 50 files at once
  },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

// Upload endpoint with enhanced error handling
app.post("/api/upload", upload.array("files", 50), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    const uploadResults = [];
    const errors = [];

    // Process files sequentially to avoid overwhelming the server
    for (const file of req.files) {
      try {
        const originalName = file.originalname;
        const extension = path.extname(originalName);
        const blobName = `${Date.now()}-${Math.random()
          .toString(36)
          .substr(2, 9)}${extension}`;

        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.upload(file.buffer, file.buffer.length, {
          blobHTTPHeaders: { blobContentType: file.mimetype },
        });

        const fileUrl = blockBlobClient.url;

        // Save to MongoDB
        const dbFile = new File({
          filename: blobName,
          originalName: originalName,
          url: fileUrl,
          size: file.size,
          fileType: file.mimetype,
        });

        await dbFile.save();

        uploadResults.push({
          id: dbFile._id,
          originalName: originalName,
          url: fileUrl,
          size: file.size,
          fileType: file.mimetype,
          uploadDate: dbFile.uploadDate,
        });
      } catch (err) {
        console.error(`Error uploading ${file.originalname}:`, err);
        errors.push({
          filename: file.originalname,
          error: err.message,
        });
      }
    }

    res.json({
      success: true,
      uploadedFiles: uploadResults,
      errors: errors,
      message: `Uploaded ${uploadResults.length} files, ${errors.length} failed`,
    });
  } catch (err) {
    console.error("Upload endpoint error:", err);
    res.status(500).json({
      success: false,
      error: "Upload failed",
      details: err.message,
    });
  }
});

// Get files endpoint with pagination and filtering
app.get("/api/files", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sort = "-uploadDate",
      search = "",
    } = req.query;

    const query = {};
    if (search) {
      query.$or = [
        { originalName: { $regex: search, $options: "i" } },
        { fileType: { $regex: search, $options: "i" } },
      ];
    }

    const files = await File.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await File.countDocuments(query);

    res.json({
      success: true,
      files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error("Error fetching files:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch files",
    });
  }
});

// Delete file endpoint
app.delete("/api/files/:id", async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete from Azure
    const blobName = file.filename;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.delete();

    // Delete from MongoDB
    await File.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "File deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting file:", err);
    res.status(500).json({
      success: false,
      error: "Failed to delete file",
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at http://localhost:${PORT}`);
});
