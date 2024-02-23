import dotenv from 'dotenv';
dotenv.config();

import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import Bottleneck from 'bottleneck';
import { arc200 } from 'ulujs';

// Initialize a new Bottleneck instance with the desired rate limits
const limiter = new Bottleneck({
    // Allow up to 10 transactions per second
    maxConcurrent: 10,
    minTime: 1000 / 10 // Wait at least 100ms between each task
});

// Derive the directory name (__dirname equivalent) and file name (__filename equivalent) in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const API_SERVER = process.env.API_SERVER;
const API_PORT = process.env.API_PORT; // This can be empty if not needed
const API_TOKEN = {
    'X-API-Key': process.env.API_TOKEN
};
const INDEXER_SERVER = process.env.INDEXER_SERVER;
const INDEXER_PORT = process.env.INDEXER_PORT; // This can be empty if not needed
const INDEXER_TOKEN = {
    'X-API-Key': process.env.INDEXER_TOKEN
};

// Initialize Algorand client
const algodClient = new algosdk.Algodv2(API_TOKEN, API_SERVER, API_PORT);
const indexerClient = new algosdk.Indexer(
    INDEXER_TOKEN,
    INDEXER_SERVER,
    INDEXER_PORT
  );

// Funding account - replace with your mnemonic
const funderAccountMnemonic = process.env.FUNDER_ACCOUNT_MNEMONIC;
const funderAccount = algosdk.mnemonicToSecretKey(funderAccountMnemonic);

// Base directory where wallets folders are located
const baseDir = __dirname; // Current directory

// Amount to fund each wallet (in microVoi)
const voiFundingAmount = parseInt(process.env.VOI_FUNDING_AMOUNT, 10); // example: 100000 microVoi = 0.1 Voi
const viaFundingAmount = parseInt(process.env.VOI_FUNDING_AMOUNT, 10);
const VIA_APP_ID = parseInt(process.env.VIA_APP_ID, 10);

// Initialize ARC200 Contract instance with VIA_APP_ID
const contract = new arc200(VIA_APP_ID, algodClient, {
    acc: funderAccount,
    simulate: false, // For testing purposes, set to false for actual transactions
    waitForConfirmation: true,
    formatBytes: true,
  });

// // Function to list wallet directories and prompt user for selection
// async function chooseWalletDirectory(baseDir) {
//     const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
//         .filter(dirent => dirent.isDirectory())
//         .map(dirent => dirent.name)
//         .filter(name => name.startsWith('wallets_'))
//         .sort()
//         .reverse();

//     if (dirs.length === 0) {
//         console.log("No wallet directories found.");
//         return null;
//     }

//     const rl = readline.createInterface({
//         input: process.stdin,
//         output: process.stdout
//     });

//     console.log("Available wallet directories:");
//     dirs.forEach((dir, index) => {
//         console.log(`${index + 1}: ${dir}`);
//     });

//     return new Promise((resolve) => {
//         rl.question('Enter the number of the wallet directory to fund: ', (answer) => {
//             const dirIndex = parseInt(answer, 10) - 1;
//             if (dirIndex >= 0 && dirIndex < dirs.length) {
//                 resolve(path.join(baseDir, dirs[dirIndex]));
//             } else {
//                 console.log("Invalid selection.");
//                 resolve(null);
//             }
//             rl.close();
//         });
//     });
// }

// Automatically choosing the first wallet directory without prompting the user
async function chooseWalletDirectory(baseDir) {
    const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter(name => name.startsWith('wallets_'))
        .sort()
        .reverse();

    if (dirs.length === 0) {
        console.log("No wallet directories found.");
        return null;
    }

    // Automatically select the first directory without prompting the user
    return path.join(baseDir, dirs[0]);
}

async function fundWallets() {
    try {
        const selectedWalletDir = await chooseWalletDirectory(baseDir);
        if (!selectedWalletDir) {
            return;
        }

        const walletFilePath = path.join(selectedWalletDir, 'voi_wallets.json');
        if (!fs.existsSync(walletFilePath)) {
            console.error("Wallet file not found in the selected directory.");
            return;
        }

        const walletsData = fs.readFileSync(walletFilePath);
        const wallets = JSON.parse(walletsData);
        const params = await algodClient.getTransactionParams().do();

        console.log("Starting to fund wallets with Voi...");
        await processWallets(wallets, params, sendFunds);

        console.log("Starting to send VIA tokens to wallets...");
        await processWallets(wallets, params, sendVIA);

    } catch (error) {
        console.error("An unexpected error occurred during the funding process:", error);
    }
}

async function processWallets(wallets, params, actionFunction) {
    const sendPromises = wallets.map(wallet => limiter.schedule(() => actionFunction(wallet, params)));

    const results = await Promise.allSettled(sendPromises);
    const failedWallets = results.filter(result => result.status === 'rejected' || (result.value && result.value.error)).map(result => result.value);

    if (failedWallets.length > 0) {
        const failedWalletsFilePath = path.join(selectedWalletDir, `failed_${actionFunction.name}_wallets.json`);
        fs.writeFileSync(failedWalletsFilePath, JSON.stringify(failedWallets, null, 2));
        console.log(`Failed ${actionFunction.name} attempts have been saved to ${failedWalletsFilePath}`);
    } else {
        console.log(`All wallets were successfully processed by ${actionFunction.name}.`);
    }
}

async function sendFunds(wallet, params) {
    try {
        const txn = algosdk.makePaymentTxnWithSuggestedParams(
            funderAccount.addr,
            wallet.publicKey,
            voiFundingAmount,
            undefined, // closeRemainderTo
            undefined, // note
            params
        );

        const signedTxn = txn.signTxn(funderAccount.sk);
        const { txId } = await algodClient.sendRawTransaction(signedTxn).do();
        await waitForConfirmation(txId);
        console.log(`Successfully funded wallet ${wallet.publicKey} with Voi. Transaction ID: ${txId}`);
        return null; // No error, successful transaction
    } catch (error) {
        console.error(`Failed to fund wallet ${wallet.publicKey} with Voi: ${error}`);
        return { ...wallet, error: error.toString() }; // Return wallet with sending error
    }
}

async function sendVIA(wallet, params) {
    try {
      // Transfer tokens to the specified address
      await contract.arc200_transfer(wallet.publicKey, viaFundingAmount, false, true);
      console.log(`Successfully sent VIA to wallet ${wallet.publicKey}`);
    } catch (error) {
      console.error(`Failed to send VIA to wallet ${wallet.publicKey}: ${error}`);
      throw { ...wallet, error: error.toString() };
    }
  }

// Utility function to wait for transaction confirmation
async function waitForConfirmation(txId) {
    let response = await algodClient.status().do();
    let lastRound = response['last-round'];
    while (true) {
        const status = await algodClient.pendingTransactionInformation(txId).do();
        if (status['confirmed-round'] !== null && status['confirmed-round'] > 0) {
            // Transaction confirmed
            break;
        }
        lastRound++;
        await algodClient.statusAfterBlock(lastRound).do();
    }
}

fundWallets();
