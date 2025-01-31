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

// Helper function to fetch NFT owners in optimized batches
const fetchNftOwners = async (collectionTicker, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    let tokensNumber = '0';
    const addressesArr = [];

    const response = await fetch(
        `${apiProvider}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();

    const makeCalls = async () => {
        const repeats = Math.ceil(Number(tokensNumber) / 100);
        const throttle = pThrottle({
            limit: 2,
            interval: 1000
        });

        let madeRequests = 0;
        const throttled = throttle(async (index) => {
            try {
                const response = await fetch(
                    `${apiProvider}/collections/${collectionTicker}/nfts?withOwner=true&from=${
                        index * 100
                    }&size=100`
                );

                if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

                const data = await response.json();

                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),
                    attributes: token.metadata?.attributes || []
                }));

                addressesArr.push(...addrs);
                madeRequests++;
            } catch (error) {
                console.error(`Error in batch ${index}:`, error.message);
            }

            if (madeRequests >= repeats) {
                return addressesArr.flat();
            }
        });

        const promises = [];
        for (let step = 0; step < repeats; step++) {
            promises.push(throttled(step));
        }
        await Promise.all(promises);
    };

    await makeCalls();

    if (!includeSmartContracts) {
        addressesArr = addressesArr.filter(
            (addrObj) => typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addressesArr;
};

// Helper function to detect if the address is a Smart Contract
const isSmartContractAddress = (address) => {
    return address.startsWith('erd1qqqqqqqqqqqqq');
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

// Function to check if a wallet is whitelisted
const isWhitelisted = (walletAddress) => {
    const whitelistedWallets = process.env.WHITELISTED_WALLETS?.split(',') || [];
    return whitelistedWallets.includes(walletAddress);
};

// Function to send the usage fee transaction
const sendUsageFee = async (pemContent) => {
    try {
        const signer = UserSigner.fromPem(pemContent);
        const senderAddress = signer.getAddress();

        const accountOnNetwork = await provider.getAccount(senderAddress);
        const senderNonce = accountOnNetwork.nonce;

        // Ensure that TREASURY_WALLET is defined
        if (!TREASURY_WALLET) {
            throw new Error("Treasury wallet address is not defined.");
        }

        const tx = new Transaction({
            nonce: senderNonce,
            receiver: new Address(TREASURY_WALLET),  // Fixed receiver wallet
            sender: senderAddress,
            value: USAGE_FEE.toString(),  // Ensures usage fee is a string
            gasLimit: 7000000, // Standard gas limit
            data: new TransactionPayload("Usage Fee Payment"),
            chainID: '1',
        });

        await signer.sign(tx);
        const txHash = await provider.sendTransaction(tx);
        return txHash.toString();
    } catch (error) {
        console.error("Error sending usage fee:", error.message);
        throw new Error("Usage fee transaction failed.");
    }
};


// Middleware to process the usage fee payment
const handleUsageFee = async (req, res, next) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        // Check if wallet is whitelisted
        if (isWhitelisted(walletAddress)) {
            console.log(`Wallet ${walletAddress} is whitelisted. Skipping usage fee.`);
            next();
            return;
        }

        // Execute the usage fee transaction
        const txHash = await sendUsageFee(pemContent);
        req.usageFeeHash = txHash;  // Attach transaction hash to the request
        next();
    } catch (error) {
        console.error("Error processing UsageFee:", error.message);
        res.status(400).json({ error: error.message });
    }
};


// Helper function to generate unique owner stats
const generateUniqueOwnerStats = (data) => {
    const stats = {};

    data.forEach(({ owner }) => {
        if (!stats[owner]) {
            stats[owner] = 0;
        }
        stats[owner] += 1; // Each NFT counts as 1 for the owner
    });

    return Object.entries(stats)
        .map(([owner, tokensCount]) => ({ owner, tokensCount }))
        .sort((a, b) => b.tokensCount - a.tokensCount);
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

        // Generate unique owner stats
        const uniqueOwnerStats = filteredAddresses.reduce((stats, item) => {
            if (!stats[item.owner]) {
                stats[item.owner] = 0;
            }
            stats[item.owner] += 1; // Increment the count for each NFT owned
            return stats;
        }, {});

        const uniqueOwnerStatsArray = Object.entries(uniqueOwnerStats).map(([owner, tokensCount]) => ({
            owner,
            tokensCount,
        }));

        uniqueOwnerStatsArray.sort((a, b) => b.tokensCount - a.tokensCount); // Sort descending by token count

        // Return the unique owner stats
        res.json({
            uniqueOwnerStats: uniqueOwnerStatsArray,
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

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
