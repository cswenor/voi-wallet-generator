require('dotenv').config();

const algosdk = require('algosdk');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Bottleneck = require('bottleneck');

// Initialize a new Bottleneck instance with the desired rate limits
const limiter = new Bottleneck({
    // Allow up to 10 transactions per second
    maxConcurrent: 10,
    minTime: 1000 / 10 // Wait at least 100ms between each task
});

// Load environment variables
const API_SERVER = process.env.API_SERVER;
const API_PORT = process.env.API_PORT; // This can be empty if not needed
const API_TOKEN = {
    'X-API-Key': process.env.API_TOKEN
};

// Initialize Algorand client
const algodClient = new algosdk.Algodv2(API_TOKEN, API_SERVER, API_PORT);

// Funding account - replace with your mnemonic
const funderAccountMnemonic = process.env.FUNDER_ACCOUNT_MNEMONIC;
const funderAccount = algosdk.mnemonicToSecretKey(funderAccountMnemonic);

// Base directory where wallets folders are located
const baseDir = __dirname; // Current directory

// Amount to fund each wallet (in microAlgos)
const fundingAmount = parseInt(process.env.FUNDING_AMOUNT, 10); // example: 100000 microAlgos = 0.1 Algo

// Function to list wallet directories and prompt user for selection
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

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log("Available wallet directories:");
    dirs.forEach((dir, index) => {
        console.log(`${index + 1}: ${dir}`);
    });

    return new Promise((resolve) => {
        rl.question('Enter the number of the wallet directory to fund: ', (answer) => {
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
        const sendPromises = wallets.map((wallet, index) => limiter.schedule(() => {
            const txn = algosdk.makePaymentTxnWithSuggestedParams(
                funderAccount.addr,
                wallet.publicKey,
                fundingAmount,
                undefined, // closeRemainderTo
                undefined, // note
                params
            );

            const signedTxn = txn.signTxn(funderAccount.sk);
            return algodClient.sendRawTransaction(signedTxn).do().then(({ txId }) => {
                return waitForConfirmation(txId).then(() => {
                    console.log(`Successfully funded wallet ${wallet.publicKey}. Transaction ID: ${txId}`);
                    return null; // No error, successful transaction
                }).catch((error) => {
                    console.error(`Error confirming transaction for wallet ${wallet.publicKey}: ${error}`);
                    return { ...wallet, error: error.toString() }; // Return wallet with confirmation error
                });
            }).catch((error) => {
                console.error(`Failed to fund wallet ${wallet.publicKey}: ${error}`);
                return { ...wallet, error: error.toString() }; // Return wallet with sending error
            });
        }));

        const results = await Promise.allSettled(sendPromises);
        const failedWallets = results.filter(result => result.status === 'rejected' || (result.status === 'fulfilled' && result.value !== null)).map(result => result.value);

        if (failedWallets.length > 0) {
            const failedWalletsFilePath = path.join(selectedWalletDir, 'failed-voi_wallets.json');
            fs.writeFileSync(failedWalletsFilePath, JSON.stringify(failedWallets, null, 2));
            console.log(`Failed funding attempts have been saved to ${failedWalletsFilePath}`);
        } else {
            console.log("All wallets were successfully funded.");
        }
    } catch (error) {
        console.error("An unexpected error occurred during the funding process:", error);
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
