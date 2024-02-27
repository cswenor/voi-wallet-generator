// Import necessary modules
import dotenv from 'dotenv';
dotenv.config();
import algosdk from 'algosdk';
import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import Bottleneck from 'bottleneck';
import { fileURLToPath } from 'url';
import { arc200 } from 'ulujs';

// Convert __dirname for use with ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const API_SERVER = process.env.API_SERVER;
const API_PORT = process.env.API_PORT;
const API_TOKEN = { 'X-API-Key': process.env.API_TOKEN };
const INDEXER_SERVER = process.env.INDEXER_SERVER;
const INDEXER_PORT = process.env.INDEXER_PORT; // This can be empty if not needed
const INDEXER_TOKEN = {
    'X-API-Key': process.env.INDEXER_TOKEN
};
const funderAccountMnemonic = process.env.FUNDER_ACCOUNT_MNEMONIC;

const VIA_APP_ID = parseInt(process.env.VIA_APP_ID, 10);

// Initialize Algorand client
const algodClient = new algosdk.Algodv2(API_TOKEN, API_SERVER, API_PORT);
const indexerClient = new algosdk.Indexer(
    INDEXER_TOKEN,
    INDEXER_SERVER,
    INDEXER_PORT
  );

// Restore the funder account from mnemonic
const funderAccount = algosdk.mnemonicToSecretKey(funderAccountMnemonic);

// Initialize a new Bottleneck instance for rate limiting
const limiter = new Bottleneck({
    maxConcurrent: 10, // Adjust based on your needs
    minTime: 100 / 10 // 10 transactions per second
});

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

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("Available wallet directories:");
    dirs.forEach((dir, index) => {
        console.log(`${index + 1}: ${dir}`);
    });

    return new Promise((resolve) => {
        rl.question('Enter the number of the wallet directory to process: ', (answer) => {
            const dirIndex = parseInt(answer, 10) - 1;
            if (dirIndex >= 0 && dirIndex < dirs.length) {
                resolve(path.join(baseDir, dirs[dirIndex]));
            } else {
                console.log("Invalid selection.");
                resolve(null);
            }
            rl.close();
        });
    });
}

async function closeOutWallets(walletFilePath) {
    try {
        const walletsData = fs.readFileSync(walletFilePath);
        const wallets = JSON.parse(walletsData);

        const params = await algodClient.getTransactionParams().do();
        const closePromises = wallets.map(wallet => limiter.schedule(() => transferVIAAndCloseWallet(wallet, params)));

        await Promise.allSettled(closePromises);
        console.log("All wallets have been processed for closing out.");
    } catch (error) {
        console.error("An error occurred while closing out wallets:", error);
    }
}

async function closeWallet(wallet, params) {
    try {
        const privateKeyUint8Array = new Uint8Array(wallet.privateKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        const accountInfo = await algodClient.accountInformation(wallet.publicKey).do();
        if (accountInfo.amount <= 0) {
            console.log(`Wallet ${wallet.publicKey} already empty.`);
            return;
        }

        const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            from: wallet.publicKey,
            to: funderAccount.addr,
            amount: 0, // Set to 0 to close out and send remaining balance
            closeRemainderTo: funderAccount.addr,
            suggestedParams: {
                ...params,
                flatFee: true,
                fee: 1000 // Min fee
            }
        });

        const signedTxn = algosdk.signTransaction(txn, privateKeyUint8Array);
        const { txId } = await algodClient.sendRawTransaction(signedTxn.blob).do();
        await waitForConfirmation(txId);
        console.log(`Wallet ${wallet.publicKey} closed out. TxID: ${txId}`);
    } catch (error) {
        console.error(`Error closing wallet ${wallet.publicKey}:`, error);
    }
}

async function waitForConfirmation(txId) {
    let response = await algodClient.status().do();
    let lastRound = response['last-round'];
    while (true) {
        const status = await algodClient.pendingTransactionInformation(txId).do();
        if (status['confirmed-round'] !== null && status['confirmed-round'] > 0) {
            break;
        }
        lastRound++;
        await algodClient.statusAfterBlock(lastRound).do();
    }
}

async function transferVIAAndCloseWallet(wallet, params) {
    try {
        // Convert privateKey from hex string to Uint8Array for signing
        const privateKeyUint8Array = new Uint8Array(wallet.privateKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        // Convert the private key to an Algorand address
        const walletAddress = algosdk.encodeAddress(privateKeyUint8Array.slice(privateKeyUint8Array.length - 32));

        // Initialize ARC200 Contract instance for the current wallet
        const contractForWallet = new arc200(VIA_APP_ID, algodClient, indexerClient, {
            acc: { addr: walletAddress, sk: privateKeyUint8Array }, // Use the current wallet's address and secret key
            simulate: false,
            waitForConfirmation: true,
            formatBytes: true,
        });

        // Get VIA balance for the current wallet using the newly initialized contract instance
        const balanceResult = await contractForWallet.arc200_balanceOf(walletAddress);
        const balance = balanceResult.returnValue; // Ensure this matches the actual return structure
        console.log(`Wallet ${walletAddress} has a VIA balance of: ${balance}`);

        if (balance > 0) {
            // Transfer VIA out of the wallet
            await contractForWallet.arc200_transfer(funderAccount.addr, balance, false, true);
            console.log(`Transferred ${balance} VIA from wallet ${wallet.publicKey}.`);
        }

        // Proceed to close out the wallet if it has any remaining ALGO balance
        const accountInfo = await algodClient.accountInformation(wallet.publicKey).do();
        if (accountInfo.amount > 0) {
            const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
                from: wallet.publicKey,
                to: funderAccount.addr,
                amount: 0, // Set to 0 to close out and send remaining balance
                closeRemainderTo: funderAccount.addr,
                suggestedParams: {
                    ...params,
                    flatFee: true,
                    fee: 1000 // Min fee
                }
            });

            const signedTxn = algosdk.signTransaction(txn, privateKeyUint8Array);
            const { txId } = await algodClient.sendRawTransaction(signedTxn.blob).do();
            await waitForConfirmation(txId);
            console.log(`Wallet ${wallet.publicKey} closed out. TxID: ${txId}`);
        } else {
            console.log(`Wallet ${wallet.publicKey} has no ALGO balance to close.`);
        }
    } catch (error) {
        console.error(`Error in processing wallet ${wallet.publicKey}:`, error);
        throw error; // Rethrow to handle in bulk operation with Promise.allSettled
    }
}

async function main() {
    try {
        const selectedWalletDir = await chooseWalletDirectory(__dirname);
        if (!selectedWalletDir) {
            console.log("Operation cancelled or no valid selection made.");
            return;
        }

        const walletFilePath = path.join(selectedWalletDir, 'voi_wallets.json'); // Change 'wallets.json' to the actual filename
        await closeOutWallets(walletFilePath);
        console.log("Process completed.");
    } catch (error) {
        console.error("An error occurred:", error);
    }
}

main();
