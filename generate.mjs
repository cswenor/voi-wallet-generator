import fs from 'fs';
import algosdk from 'algosdk';
import QRCode from 'qrcode';
import readline from 'readline';

const wallets = [];

async function generateWallet(outputDirectory, index) {
  const account = algosdk.generateAccount();
  const privateKeyHex = Buffer.from(account.sk).toString('hex');
  const qrCodeUri = `avm://account/import?encoding=hex&privatekey=${privateKeyHex}&asset=6779767`;

  const qrCodesDir = `${outputDirectory}/qrcodes`;
  if (!fs.existsSync(qrCodesDir)) {
    fs.mkdirSync(qrCodesDir, { recursive: true });
  }

  const qrCodeFilename = `${qrCodesDir}/wallet_${index + 1}.png`;
  await QRCode.toFile(qrCodeFilename, qrCodeUri);

  wallets.push({
    publicKey: account.addr,
    privateKey: privateKeyHex,
    qrCodeUri: qrCodeFilename,
  });
}

async function promptForNumberOfWallets() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('How many wallets do you want to create? ', (answer) => {
      const numberOfWallets = parseInt(answer, 10);
      rl.close();
      if (!isNaN(numberOfWallets) && numberOfWallets > 0) {
        resolve(numberOfWallets);
      } else {
        console.log("Please enter a valid number.");
        resolve(promptForNumberOfWallets()); // Recursively call the prompt if input is invalid
      }
    });
  });
}

async function main() {
  const numberOfWallets = await promptForNumberOfWallets();
  const executionTimestamp = Date.now();
  const outputDirectory = `wallets_${executionTimestamp}`;

  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  for (let i = 0; i < numberOfWallets; i++) {
    await generateWallet(outputDirectory, i);
    console.log(`Wallet ${i + 1} generated.`);
  }

  const walletFilename = `${outputDirectory}/voi_wallets.json`;
  fs.writeFileSync(walletFilename, JSON.stringify(wallets, null, 2));

  console.log(`Generated ${numberOfWallets} wallets, QR codes, and saved the information to '${walletFilename}'.`);
}

main().catch((error) => {
  console.error('Error:', error);
});
