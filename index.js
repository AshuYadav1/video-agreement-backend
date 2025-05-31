const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Configure multer for video uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    console.log('Received file mimetype:', file.mimetype);
    if (file.mimetype && file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else if (file.originalname.match(/\.(mp4|webm|mkv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed! Received: ' + file.mimetype), false);
    }
  }
});

// Decode and write Google service account key from base64
const decodedKeyPath = path.join(__dirname, 'temp-google-key.json');
if (!fs.existsSync(decodedKeyPath)) {
  if (!process.env.GOOGLE_KEY_BASE64) {
    console.error('Missing GOOGLE_KEY_BASE64 environment variable.');
    process.exit(1);
  }

  fs.writeFileSync(
    decodedKeyPath,
    Buffer.from(process.env.GOOGLE_KEY_BASE64, 'base64').toString('utf8')
  );
}

// Google Drive setup
const auth = new google.auth.GoogleAuth({
  keyFile: decodedKeyPath,
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Your shared Google Drive folder ID
const FOLDER_ID = '1G0J0gopla4vDAMiaKzOaMPSQ3Y0nrk0U';

// Upload endpoint
app.post('/upload-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('File received:', req.file.originalname);

    const fileMetadata = {
      name: `${Date.now()}_${req.file.originalname}`,
      parents: [FOLDER_ID]
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path)
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id,name,webViewLink'
    });

    // Optional: make file public
    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    // Clean up temporary file
    fs.unlink(req.file.path, err => {
      if (err) console.error('Error deleting temp file:', err);
    });

    console.log('Video uploaded to Drive:', driveResponse.data);

    res.json({
      success: true,
      message: 'Video uploaded successfully!',
      fileId: driveResponse.data.id,
      fileName: driveResponse.data.name,
      driveLink: driveResponse.data.webViewLink
    });

  } catch (error) {
    console.error('Upload error:', error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlink(req.file.path, err => {
        if (err) console.error('Error deleting temp file on error:', err);
      });
    }

    res.status(500).json({
      error: 'Failed to upload video',
      details: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Server is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
