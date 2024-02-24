import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';

const inchesToPoints = (inches) => inches * 72;

const pageDimensions = {
    width: inchesToPoints(8.5),
    height: inchesToPoints(11),
};

const labelDimensions = {
    width: inchesToPoints(1),
    height: inchesToPoints(1),
};

const margins = {
    top: inchesToPoints(0.5),
    side: inchesToPoints(0.375),
};

const pitch = {
    vertical: inchesToPoints(1.125),
    horizontal: inchesToPoints(1.125),
};

const numberAcross = 7;
const numberDown = 9;

async function chooseDirectory(baseDir) {
    const walletDirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('wallets_'))
        .map(dirent => dirent.name)
        .sort((a, b) => parseInt(b.split('_')[1]) - parseInt(a.split('_')[1])); // Newest first

    if (walletDirs.length === 0) {
        console.log("No wallet directories found.");
        return null;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("Available wallet directories:");
    walletDirs.forEach((dir, index) => {
        console.log(`${index + 1}: ${dir}`);
    });

    return new Promise((resolve) => {
        rl.question('Enter the number of the wallet directory to use: ', (answer) => {
            const dirIndex = parseInt(answer, 10) - 1;
            if (dirIndex >= 0 && dirIndex < walletDirs.length) {
                resolve(path.join(baseDir, walletDirs[dirIndex])); // Resolve with the selected wallet directory
            } else {
                console.log("Invalid selection.");
                resolve(null);
            }
            rl.close();
        });
    });
}

async function createPDFWithQRCodes(walletDir) {
    const qrCodesDir = path.join(walletDir, 'qrcodes');
    const qrCodeFiles = fs.readdirSync(qrCodesDir).filter(file => file.endsWith('.png'));
    const pdfPath = path.join(walletDir, 'qr_codes.pdf');
    const doc = new PDFDocument({ size: [pageDimensions.width, pageDimensions.height], margin: 0 });
  
    doc.pipe(fs.createWriteStream(pdfPath));
  
    let pageNumber = 0;
    qrCodeFiles.forEach((file, index) => {
      const positionIndex = index - pageNumber * numberAcross * numberDown;
      const row = Math.floor(positionIndex / numberAcross);
      const column = positionIndex % numberAcross;
      const x = margins.side + column * pitch.horizontal;
      const y = margins.top + row * pitch.vertical;
  
      if (positionIndex > 0 && positionIndex % (numberAcross * numberDown) === 0) {
        doc.addPage();
        pageNumber++;
      }
  
      doc.image(path.join(qrCodesDir, file), x, y, { width: labelDimensions.width, height: labelDimensions.height });
    });
  
    doc.end();
    console.log(`PDF created at ${pdfPath} with ${qrCodeFiles.length} QR codes.`);
  }

async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const baseDir = __dirname; // Use the directory of the current script
    const selectedDir = await chooseDirectory(baseDir);

    if (selectedDir) {
        await createPDFWithQRCodes(selectedDir);
    } else {
        console.log('No directory selected or available.');
    }
}

main().catch((error) => {
    console.error('Error:', error);
});
