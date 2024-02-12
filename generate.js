const fs = require('fs');
const algosdk = require('algosdk');
const QRCode = require('qrcode');

const numberOfWallets = 10; // Change this to the desired number of wallets

const wallets = [];

async function generateWallet(outputDirectory) {
  // Generate a new Algorand account
  const account = algosdk.generateAccount();

  // Convert the secret key (sk) to a hex string
  const privateKeyHex = Buffer.from(account.sk).toString('hex');

  // Generate the QR code URI using the hex-encoded private key
  const qrCodeUri = `avm://account/import?encoding=hex&privateKey=${privateKeyHex}`;

  // Ensure the 'qrcodes' subdirectory exists within the output directory
  const qrCodesDir = `${outputDirectory}/qrcodes`;
  if (!fs.existsSync(qrCodesDir)) {
    fs.mkdirSync(qrCodesDir, { recursive: true });
  }

  // Generate and save the QR code
  const qrCodeFilename = `${qrCodesDir}/wallet_${wallets.length + 1}.png`;
  await QRCode.toFile(qrCodeFilename, qrCodeUri);

  // Store wallet information, including the hex-encoded private key
  wallets.push({
    publicKey: account.addr,
    privateKey: privateKeyHex, // Store the hex-encoded private key
    qrCodeUri: qrCodeFilename,
  });
}

async function main() {
  // Generate a timestamp for the output directory name
  const executionTimestamp = Date.now();
  const outputDirectory = `wallets_${executionTimestamp}`;

  // Create the output directory
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  for (let i = 0; i < numberOfWallets; i++) {
    await generateWallet(outputDirectory);
    console.log(`Wallet ${i + 1} generated.`);
  }

  // Write wallet information to a JSON file within the output directory
  const walletFilename = `${outputDirectory}/voi_wallets.json`;
  fs.writeFileSync(walletFilename, JSON.stringify(wallets, null, 2));

  console.log(`Generated ${numberOfWallets} wallets, QR codes, and saved the information to '${walletFilename}'.`);
}

main().catch((error) => {
  console.error(error);
});
