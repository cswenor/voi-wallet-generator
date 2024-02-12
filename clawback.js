require('dotenv').config();
const algosdk = require('algosdk');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Bottleneck = require('bottleneck');

// Load environment variables
const API_SERVER = process.env.API_SERVER;
const API_PORT = process.env.API_PORT;
const API_TOKEN = {
    'X-API-Key': process.env.API_TOKEN
};
const funderAccountMnemonic = process.env.FUNDER_ACCOUNT_MNEMONIC;

// Initialize Algorand client
const algodClient = new algosdk.Algodv2(API_TOKEN, API_SERVER, API_PORT);

// Restore the funder account from mnemonic
const funderAccount = algosdk.mnemonicToSecretKey(funderAccountMnemonic);

// Initialize a new Bottleneck instance for rate limiting
const limiter = new Bottleneck({
    maxConcurrent: 10, // Adjust based on your needs
    minTime: 100 / 10 // 10 transactions per second
});

const baseDir = __dirname; // Current directory

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
        const closePromises = wallets.map(wallet => limiter.schedule(() => closeWallet(wallet, params)));

        await Promise.allSettled(closePromises);
        console.log("All wallets have been processed for closing out.");
    } catch (error) {
        console.error("An error occurred while closing out wallets:", error);
    }
}

async function closeWallet(wallet, params) {
    try {
        // Assuming wallet.privateKey is a hex string, convert it to a Uint8Array
        const privateKeyUint8Array = new Uint8Array(wallet.privateKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));

        const accountInfo = await algodClient.accountInformation(wallet.publicKey).do();
        if (accountInfo.amount <= 0) {
            console.log(`Wallet ${wallet.publicKey} already empty.`);
            return;
        }

        const txn = {
            from: wallet.publicKey,
            to: funderAccount.addr,
            fee: params.fee,
            firstRound: params.firstRound,
            lastRound: params.lastRound,
            genesisID: params.genesisID,
            genesisHash: params.genesishashb64,
            amount: 0, // Set to 0 to close out and send remaining balance
            closeRemainderTo: funderAccount.addr, // Close remainder to funder account
            note: undefined, // Optional note
        };

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
            // Transaction confirmed
            break;
        }
        lastRound++;
        await algodClient.statusAfterBlock(lastRound).do();
    }
}

async function main() {
    try {
        const selectedWalletDir = await chooseWalletDirectory(baseDir);
        if (!selectedWalletDir) {
            console.log("Operation cancelled or no valid selection made.");
            return;
        }

        const walletFilePath = path.join(selectedWalletDir, 'voi_wallets.json');
        await closeOutWallets(walletFilePath);
        console.log("Process completed.");
    } catch (error) {
        console.error("An error occurred:", error);
    }
}

main();
