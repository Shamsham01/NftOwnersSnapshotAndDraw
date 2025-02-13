import { 
    Address, 
    TransactionsFactoryConfig, 
    TransferTransactionsFactory, 
    TokenTransfer, 
    Token, 
    Transaction, 
    TransactionPayload
} from '@multiversx/sdk-core';

import fetch from 'node-fetch';
import ora from 'ora';
import pThrottle from 'p-throttle';
import express from 'express';
import bodyParser from 'body-parser';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { UserSigner } from '@multiversx/sdk-wallet';
import { format as formatCsv } from 'fast-csv';
import { Readable } from 'stream';
import BigNumber from 'bignumber.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const USAGE_FEE = 500; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

const whitelistFilePath = path.join(__dirname, 'whitelist.json');


app.use(bodyParser.json());  // Support JSON-encoded bodies

// Middleware to check authorization token for protected routes
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// New Authorization Endpoint for Make.com to verify connection
app.post('/authorization', (req, res) => {
    try {
        const token = req.headers.authorization;
        if (token === `Bearer ${SECURE_TOKEN}`) {
            res.json({ message: "Authorization successful" });
        } else {
            res.status(401).json({ error: "Unauthorized" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch token decimals
const getTokenDecimals = async (tokenTicker) => {
    const apiUrl = `https://api.multiversx.com/tokens/${tokenTicker}`;
    const response = await fetch(apiUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch token info: ${response.statusText}`);
    }
    const tokenInfo = await response.json();
    return tokenInfo.decimals || 0;
};

const convertAmountToBlockchainValue = (amount, decimals) => {
    const factor = new BigNumber(10).pow(decimals);
    return new BigNumber(amount).multipliedBy(factor).toFixed(0);
};

const checkTransactionStatus = async (txHash, retries = 40, delay = 5000) => {
    const txStatusUrl = `https://api.multiversx.com/transactions/${txHash}`;

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(txStatusUrl);

            if (!response.ok) {
                console.warn(`Non-200 response for ${txHash}: ${response.status}`);
                throw new Error(`HTTP error ${response.status}`);
            }

            const txStatus = await response.json();

            if (txStatus.status === "success") {
                return { status: "success", txHash };
            } else if (txStatus.status === "fail") {
                return { status: "fail", txHash };
            }

            console.log(`Transaction ${txHash} still pending, retrying...`);
        } catch (error) {
            console.error(`Error fetching transaction ${txHash}: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(
        `Transaction ${txHash} status could not be determined after ${retries} retries.`
    );
};

// Helper function to generate CSV data as a string
const generateCsv = async (data) => {
    const csvData = [];
    data.forEach((row) => {
        csvData.push({
            address: row.address || row.owner,
            identifier: row.identifier || '',
            balance: row.balance || '',
            metadataFileName: row.metadataFileName || '',
            attributes: row.attributes ? JSON.stringify(row.attributes) : ''
        });
    });

    return new Promise((resolve, reject) => {
        const csvStream = formatCsv({ headers: true });
        const chunks = [];

        csvStream.on('data', (chunk) => chunks.push(chunk.toString()));
        csvStream.on('end', () => resolve(chunks.join('')));
        csvStream.on('error', reject);

        csvData.forEach((row) => csvStream.write(row));
        csvStream.end();
    });
};

// Helper function to fetch NFT owners with retry and exponential backoff
const fetchNftOwnersInBatches = async (collectionTicker, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    const MAX_SIZE = 100;
    let addressesArr = [];

    // Fetch total NFT count
    const response = await fetch(`${apiProvider}/collections/${collectionTicker}/nfts/count`);
    const tokensNumber = parseInt(await response.text(), 10);

    // Retry logic with exponential backoff
    const fetchWithRetry = async (url, retries = 5, delay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
                return await response.json();
            } catch (error) {
                console.error(`Error fetching data (attempt ${attempt}): ${error.message}`);
                if (attempt === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, delay * attempt)); // Exponential backoff
            }
        }
    };

    // Fetch data in batches to prevent rate limits
    const makeCalls = async () => {
        const repeats = Math.ceil(tokensNumber / MAX_SIZE);
        const throttle = pThrottle({ limit: 2, interval: 1000 }); // Adjust limit dynamically if needed

        const throttled = throttle(async (index) => {
            const url = `${apiProvider}/collections/${collectionTicker}/nfts?withOwner=true&from=${index * MAX_SIZE}&size=${MAX_SIZE}`;
            try {
                const data = await fetchWithRetry(url);
                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),
                    attributes: token.metadata?.attributes || []
                }));
                addressesArr.push(...addrs);
            } catch (error) {
                console.error(`Failed in batch ${index}: ${error.message}`);
            }
        });

        const promises = [];
        for (let step = 0; step < repeats; step++) {
            promises.push(throttled(step));
        }
        await Promise.all(promises);
    };

    await makeCalls();

    // Exclude smart contract addresses if required
    if (!includeSmartContracts) {
        addressesArr = addressesArr.filter(
            (addrObj) => typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addressesArr;
};


// Helper function to detect if an address is a Smart Contract OR the Burn SC
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq') || 
           address === 'erd1deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaqtv0gag'; 
};

// Helper function to decode metadata attributes and get the file name
const getMetadataFileName = (attributes) => {
    const attrsDecoded = attributes
        ? Buffer.from(attributes, 'base64').toString()
        : undefined;
    if (!attrsDecoded) return '';

    const metadataKey = attrsDecoded
        .split(';')
        .filter((item) => item.includes('metadata'))?.[0];

    if (!metadataKey) return '';

    return metadataKey.split('/')?.[1].split('.')?.[0];
};

// Helper function to fetch token details
const fetchTokenDetails = async (token) => {
    try {
        const response = await fetch(`https://api.multiversx.com/tokens/${token}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch token details for "${token}".`);
        }
        return await response.json();
    } catch (error) {
        console.error('Error fetching token details:', error.message);
        throw error;
    }
};

// Function to validate and return the PEM content from the request body (without logging)
const getPemContent = (req) => {
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Function to derive the wallet address from a PEM file
const deriveWalletAddressFromPem = (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    return signer.getAddress().toString();
};

// Load the whitelist file
const loadWhitelist = () => {
    if (!fs.existsSync(whitelistFilePath)) {
        fs.writeFileSync(whitelistFilePath, JSON.stringify([], null, 2));
    }
    const data = fs.readFileSync(whitelistFilePath);
    return JSON.parse(data);
};

// Check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelist = loadWhitelist();
    return whitelist.some(entry => entry.walletAddress === walletAddress);
};

// Function to send usage fee
const sendUsageFee = async (pemContent) => {
    const signer = UserSigner.fromPem(pemContent);
    const senderAddress = signer.getAddress();
    const receiverAddress = new Address(TREASURY_WALLET);

    const accountOnNetwork = await provider.getAccount(senderAddress);
    const nonce = accountOnNetwork.nonce;

    const decimals = await getTokenDecimals(REWARD_TOKEN);
    const convertedAmount = convertAmountToBlockchainValue(USAGE_FEE, decimals);

    const factoryConfig = new TransactionsFactoryConfig({ chainID: "1" });
    const factory = new TransferTransactionsFactory({ config: factoryConfig });

    const tx = factory.createTransactionForESDTTokenTransfer({
        sender: senderAddress,
        receiver: receiverAddress,
        tokenTransfers: [
            new TokenTransfer({
                token: new Token({ identifier: REWARD_TOKEN }),
                amount: BigInt(convertedAmount),
            }),
        ],
    });

    tx.nonce = nonce;
    tx.gasLimit = BigInt(500000);

    await signer.sign(tx);
    const txHash = await provider.sendTransaction(tx);

    const status = await checkTransactionStatus(txHash.toString());
    if (status.status !== "success") {
        throw new Error('UsageFee transaction failed. Ensure sufficient REWARD tokens are available.');
    }
    return txHash.toString();
};

// Middleware to handle usage fee
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Check if the wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next(); // Skip the usage fee and proceed
            return;
        }

        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash; // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error('Error processing UsageFee:', error.message);
        res.status(400).json({ error: error.message });
    }
};

// Helper function to fetch ESDT token details (including decimals)
const fetchTokenDecimals = async (token) => {
    try {
        const response = await fetch(`https://api.multiversx.com/tokens/${token}`);
        if (!response.ok) {
            throw new Error(`Failed to fetch token details for "${token}".`);
        }
        const tokenData = await response.json();
        return tokenData.decimals || 0; // Default to 0 if decimals are missing
    } catch (error) {
        console.error('Error fetching token decimals:', error.message);
        throw error;
    }
};



// Helper function to generate unique owner stats
const generateUniqueOwnerStats = (data, assetType = "NFT", decimals = 0) => {
    const stats = {};

    data.forEach(({ owner, address, balance }) => {
        const account = owner || address; // Handle both NFT (owner) and SFT/ESDT (address)

        if (!account) {
            console.warn("Skipping entry due to missing owner/address:", { owner, address });
            return; // Skip if no valid owner
        }

        if (!stats[account]) {
            stats[account] = 0;
        }

        if (assetType === "NFT") {
            // NFT: Each NFT counts as 1
            stats[account] += 1;
        } else if (assetType === "SFT") {
            // SFT: Whole number (no decimals)
            stats[account] += parseInt(balance || 0, 10);
        } else if (assetType === "ESDT") {
            // ESDT: Convert balance using dynamically fetched decimals
            stats[account] += parseFloat((Number(balance || 0) / 10 ** decimals).toFixed(decimals));
        }
    });

    return Object.entries(stats)
        .map(([account, tokensCount]) => ({
            owner: account,
            tokensCount: assetType === "NFT" || assetType === "SFT" ? tokensCount : tokensCount.toFixed(decimals),
        }))
        .sort((a, b) => parseFloat(b.tokensCount) - parseFloat(a.tokensCount));
};


// NFT Snapshot & Draw Endpoint
app.post('/nftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Select random winners
        const shuffled = filteredAddresses.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners).map(winner => ({
            owner: winner.owner,
            identifier: winner.identifier,
            metadataFileName: winner.metadataFileName,
        }));

        // Return only winners without CSV or unique owner stats
        res.json({
            winners,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});

// NFT Snapshot CSV Data Endpoint
app.post('/nftSnapshotCsv', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Generate CSV string
        const csvString = await generateCsv(filteredAddresses.map(address => ({
            address: address.owner,
            identifier: address.identifier,
            metadataFileName: address.metadataFileName,
            attributes: address.attributes ? JSON.stringify(address.attributes) : '', // Include attributes
        })));

        // Return CSV string
        res.json({
            csvString,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `CSV snapshot for collection ${collectionTicker} has been generated.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Snapshot CSV Data:', error);
        res.status(500).json({ error: error.message });
    }
});

// NFT Unique Owners Stats Endpoint
app.post('/nftUniqueOwnersStats', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        const addresses = await fetchNftOwnersInBatches(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found for the collection.' });
        }

        // Apply filtering based on traits if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Apply filtering based on metadata file names if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria.' });
        }

        // Use the central function for consistent unique owner stats
        const uniqueOwnerStats = generateUniqueOwnerStats(filteredAddresses, "NFT");

        // Return the unique owner stats
        res.json({
            uniqueOwnerStats,
            collectionTicker,
            includeSmartContracts,
            traitType,
            traitValue,
            fileNamesList,
            message: `Unique owner statistics for collection ${collectionTicker} have been generated.`,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during NFT Unique Owners Stats:', error);
        res.status(500).json({ error: error.message });
    }
});


// Helper function to fetch SFT owners
const fetchSftOwners = async (collectionTicker, editions, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    const owners = [];
    const size = 1000; // API allows fetching up to 1000 owners per call

    try {
        for (const edition of editions) {
            const editionTicker = `${collectionTicker}-${edition}`;
            let hasMore = true;
            let from = 0;

            while (hasMore) {
                const response = await fetch(
                    `${apiProvider}/nfts/${editionTicker}/accounts?size=${size}&from=${from}`
                );

                if (!response.ok) {
                    console.error('API response:', response.status, await response.text());
                    throw new Error(`Failed to fetch owners for SFT edition "${editionTicker}".`);
                }

                const data = await response.json();
                if (data.length === 0) {
                    hasMore = false;
                } else {
                    const filteredOwners = data.filter(owner =>
                        includeSmartContracts || !isSmartContractAddress(owner.address)
                    );

                    filteredOwners.forEach(owner => {
                        owners.push({
                            address: owner.address,
                            balance: owner.balance,
                        });
                    });

                    from += size;
                    hasMore = data.length === size;
                }
            }
        }

        return owners;
    } catch (error) {
        console.error('Error fetching SFT owners:', error.message);
        throw error;
    }
};

// SFT Snapshot & Draw Endpoint
app.post('/sftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, editions, numberOfWinners, includeSmartContracts } = req.body;

        if (!collectionTicker || !editions || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: collectionTicker, editions, numberOfWinners' });
        }

        // Convert editions input to an array (e.g., "01,02,03" -> ["01", "02", "03"])
        const editionArray = editions.split(',').map(e => e.trim());

        // Fetch SFT owners
        const sftOwners = await fetchSftOwners(collectionTicker, editionArray, includeSmartContracts);
        if (sftOwners.length === 0) {
            return res.status(404).json({ error: 'No SFT owners found for the specified collection and editions' });
        }

        // ✅ Generate unique owner stats with updated function
        const uniqueOwnerStats = generateUniqueOwnerStats(sftOwners, "SFT");

        // Randomly select winners
        const shuffled = sftOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV for all SFT owners
        const csvString = await generateCsv(sftOwners.map(owner => ({
            address: owner.address,
            balance: owner.balance,
        })));

        // Response payload
        res.json({
            winners,
            uniqueOwnerStats, // ✅ This now includes proper owners & integer token counts
            totalOwners: sftOwners.length,
            message: `${numberOfWinners} winners have been selected from the SFT collection "${collectionTicker}" across editions "${editions}".`,
            csvString,
            usageFeeHash: req.usageFeeHash, // Attach usage fee hash
        });

    } catch (error) {
        console.error('Error during SFT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch ESDT owners in batches with retry and throttling
const fetchEsdtOwners = async (token, includeSmartContracts) => {
    const owners = new Map();
    const batchSize = 1000; // Max batch size per API call
    let from = 0;
    let totalFetched = 0;
    const maxRetries = 5;

    console.log(`Fetching owners for ESDT: ${token}`);

    const fetchWithRetry = async (url, retries = maxRetries, delay = 1000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } catch (error) {
                console.warn(`Fetch failed (attempt ${attempt}): ${error.message}`);
                if (attempt === retries) throw error;
                await new Promise(resolve => setTimeout(resolve, delay * attempt)); // Exponential backoff
            }
        }
    };

    const makeBatchRequests = async () => {
        while (true) {
            const url = `https://api.multiversx.com/tokens/${token}/accounts?size=${batchSize}&from=${from}`;
            console.log(`Fetching batch: ${from} - ${from + batchSize}`);

            try {
                const data = await fetchWithRetry(url);

                if (!data || data.length === 0) break;

                data.forEach(owner => {
                    if (includeSmartContracts || (!isSmartContractAddress(owner.address) && owner.address !== "erd1deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaqtv0gag")) {
                        owners.set(owner.address, {
                            address: owner.address,
                            balance: owner.balance,
                        });
                    }
                });

                from += batchSize;
                totalFetched += data.length;

                console.log(`Total owners fetched: ${totalFetched}`);

                // API Limit: Allow a 2-second pause between batches
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Stop if we reach 100k owners (to prevent excessive load)
                if (totalFetched >= 100000) {
                    console.warn('Reached 100,000 owners. Stopping further requests.');
                    break;
                }

            } catch (error) {
                console.error('Error fetching ESDT owners:', error.message);
                throw error;
            }
        }
    };

    await makeBatchRequests();

    return Array.from(owners.values());
};


// ESDT Snapshot & Draw Endpoint
app.post('/esdtSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { token, includeSmartContracts, numberOfWinners } = req.body;

        if (!token || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: token, numberOfWinners' });
        }

        console.log(`Starting ESDT snapshot for token: ${token}`);

        // Step 1: Fetch Token Decimals
        const decimals = await fetchTokenDecimals(token);

        // Step 2: Fetch Token Owners in Batches with API Throttling
        const esdtOwners = await fetchEsdtOwners(token, includeSmartContracts);

        if (esdtOwners.length === 0) {
            return res.status(404).json({ error: `No owners found for token: ${token}` });
        }

        console.log(`Fetched ${esdtOwners.length} ESDT owners`);

        // Step 3: Generate Unique Owner Stats
        const uniqueOwnerStats = generateUniqueOwnerStats(esdtOwners, "ESDT", decimals);

        // Step 4: Select Random Winners
        const shuffled = esdtOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Step 5: Generate CSV Output
        const csvString = await generateCsv(esdtOwners.map(owner => ({
            address: owner.address,
            balance: (Number(owner.balance || 0) / 10 ** decimals).toFixed(decimals),
        })));

        res.json({
            token,
            decimals,
            totalOwners: esdtOwners.length,
            uniqueOwnerStats,
            winners,
            csvString,
            message: `${numberOfWinners} winners have been selected from token "${token}".`,
            usageFeeHash: req.usageFeeHash,
        });

    } catch (error) {
        console.error('Error during ESDT Snapshot & Draw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Route for staked NFTs snapshot draw
app.post('/stakedNftsSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, contractLabel, numberOfWinners } = req.body;

        // Fetch staked NFTs and their owners with filters
        const stakedData = await fetchStakedNfts(collectionTicker, contractLabel);
        if (stakedData.length === 0) {
            return res.status(404).json({ error: 'No staked NFTs found for this collection' });
        }

        // Count total staked NFTs
        const totalStakedCount = stakedData.length;

        // Random selection of winners
        const shuffled = stakedData.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        // Generate CSV string
        const csvString = await generateCsv(stakedData);

        res.json({
            winners,
            totalStakedCount,
            csvString,
            message: `${numberOfWinners} winners have been selected from staked NFTs in collection ${collectionTicker}.`,
            usageFeeHash: req.usageFeeHash,
        });

    } catch (error) {
        console.error('Error during stakedNftsSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch staked NFTs
const fetchStakedNfts = async (collectionTicker, contractLabel) => {
    const contractAddresses = {
        oneDexStakedNfts: "erd1qqqqqqqqqqqqqpgqrq6gv0ljf4y9md42pe4m6mh96hcpqnpuusls97tf33",
        xoxnoStakedNfts: "erd1qqqqqqqqqqqqqpgqvpkd3g3uwludduv3797j54qt6c888wa59w2shntt6z",
        artCpaStakedNfts: "erd1qqqqqqqqqqqqqpgqfken0exk7jpr85dx6f8ym3jgcagesfcqkqys0xnquf",
        hodlFounderNfts: "erd1qqqqqqqqqqqqqpgqpvlxt3n9ks66kuq4j8cvcv25k8a5rsx99g6suw5r66",
    };

    const stakingFunctions = {
        oneDexStakedNfts: "userStake",
        xoxnoStakedNfts: "stake",
        artCpaStakedNfts: "userStake",
        hodlFounderNfts: "stake",
    };

    const contractAddress = contractAddresses[contractLabel];
    const stakeFunction = stakingFunctions[contractLabel];

    if (!contractAddress || !stakeFunction) {
        throw new Error("Unsupported contract label or staking function");
    }

    const stakedNfts = new Map();
    try {
        const fetchData = async (url) => {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP Error ${response.status}`);
            }
            const data = await response.json();
            
            // 🔴 Log first few transactions from raw API response (before filtering)
            console.log(`Fetched transactions from ${url}:`, JSON.stringify(data.slice(0, 5), null, 2));
            
            return data;
        };

        // Fetch only **successful** stake transactions
        const stakedData = (await fetchData(
            `https://api.multiversx.com/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&function=${stakeFunction}`
        )).filter(tx => {
            if (tx.status !== "success") {
                console.log(`⚠️ Skipping failed stake transaction:`, tx);
            }
            return tx.status === "success";
        });

        // Fetch only **successful** unstake transactions
        const unstakedData = (await fetchData(
            `https://api.multiversx.com/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&function=ESDTNFTTransfer`
        )).filter(tx => {
            if (tx.status !== "success") {
                console.log(`⚠️ Skipping failed unstake transaction:`, tx);
            }
            return tx.status === "success";
        });

        // Ensure transactions are processed in **chronological order**
        const allTransactions = [...stakedData, ...unstakedData].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

        allTransactions.forEach(tx => {
            const transfers = (tx.action?.arguments?.transfers || []).filter(
                transfer => transfer.collection === collectionTicker
            );

            transfers.forEach(item => {
                // **Processing Staking Events**
                if (tx.function === stakeFunction) {
                    stakedNfts.set(item.identifier, {
                        owner: tx.sender,
                        identifier: item.identifier
                    });
                // **Processing Unstaking Events** (SC sends back to user)
                } else if (tx.function === 'ESDTNFTTransfer' && tx.sender === contractAddress) {
                    stakedNfts.delete(item.identifier);
                }
            });
        });

        return Array.from(stakedNfts.values());
    } catch (error) {
        console.error("Error fetching staked NFTs data:", error.message);
        throw error;
    }
};


// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
