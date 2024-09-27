import { Address } from '@multiversx/sdk-core';
import fetch from 'node-fetch';
import ora from 'ora';
import pThrottle from 'p-throttle';
import express from 'express';
import bodyParser from 'body-parser';
import { ProxyNetworkProvider } from '@multiversx/sdk-network-providers';
import { UserSigner } from '@multiversx/sdk-wallet';
import fs from 'fs'; // Required for file system operations
import { format as formatCsv } from 'fast-csv'; // Required for CSV generation

const app = express();
const PORT = process.env.PORT || 10000;
const SECURE_TOKEN = process.env.SECURE_TOKEN;  // Secure Token for authorization
const MAX_SIZE = 100;
const apiProvider = {
  mainnet: 'https://api.multiversx.com',
  devnet: 'https://devnet-api.multiversx.com',
};  // Change based on network

app.use(bodyParser.json());  // Support JSON-encoded bodies

// Middleware to check authorization token
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Helper function to detect if the address is a Smart Contract
const isSmartContractAddress = (address) => {
    // Detect SC addresses like 'erd1qqqqqqqqqqqqq...'
    return address.startsWith('erd1qqqqqqqqqqqqq');
};

// Helper function to fetch NFT owners
const fetchNftOwners = async (collectionTicker, includeSmartContracts) => {
    let tokensNumber = '0';
    const addressesArr = [];

    console.log(`Fetching NFT count for collection ${collectionTicker}`); // Debug

    const response = await fetch(
        `${apiProvider.mainnet}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();
    console.log(`Total NFTs: ${tokensNumber}`); // Debug

    const makeCalls = () =>
        new Promise((resolve) => {
            const repeats = Math.ceil(Number(tokensNumber) / MAX_SIZE);
            const throttle = pThrottle({
                limit: 5,
                interval: 1000,
            });

            let madeRequests = 0;

            const throttled = throttle(async (index) => {
                const response = await fetch(
                    `${apiProvider.mainnet}/collections/${collectionTicker}/nfts?withOwner=true&from=${
                        index * MAX_SIZE
                    }&size=${MAX_SIZE}`
                );
                const data = await response.json();
                console.log(`Fetched ${data.length} NFTs in batch ${index + 1}`); // Debug

                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),
                    attributes: token.metadata ? JSON.parse(Buffer.from(token.metadata, 'base64').toString()) : []
                }));

                addressesArr.push(addrs);
                madeRequests++;
                if (madeRequests >= repeats) {
                    return resolve(addressesArr.flat());
                }
            });

            for (let step = 0; step < repeats; step++) {
                throttled(step);
            }
        });

    let addresses = await makeCalls();
    console.log(`Fetched ${addresses.length} total NFT owners`); // Debug

    if (!includeSmartContracts) {
        addresses = addresses.filter(
            (addrObj) =>
                typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    console.log(`${addresses.length} addresses after smart contract filtering`); // Debug

    return addresses;
};

// Helper function to decode metadata attributes and get the file name
const getMetadataFileName = (attributes) => {
    if (typeof attributes !== 'string') {
        // If attributes is not a string, return an empty value
        return '';
    }

    const attrsDecoded = Buffer.from(attributes, 'base64').toString();
    
    if (!attrsDecoded) return '';

    const metadataKey = attrsDecoded
        .split(';')
        .filter((item) => item.includes('metadata'))?.[0];

    if (!metadataKey) return '';

    return metadataKey.split('/')?.[1].split('.')?.[0];
};

// Function to generate CSV file
const generateCsv = (data, filePath) => {
    const csvStream = formatCsv({ headers: true });
    const writableStream = fs.createWriteStream(filePath);

    writableStream.on('finish', () => {
        console.log(`CSV file generated at ${filePath}`);
    });

    csvStream.pipe(writableStream);
    data.forEach((row) => {
        csvStream.write(row);
    });
    csvStream.end();
};

// Route for snapshotDraw
app.post('/snapshotDraw', checkToken, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners
        console.log(`Fetching NFT owners for collection ${collectionTicker}...`); // Debug
        let addresses = await fetchNftOwners(collectionTicker, includeSmartContracts);
        
        console.log(`Fetched ${addresses.length} NFT owners`); // Debug

        if (addresses.length === 0) {
            console.log('No addresses found'); // Debug
            return res.status(404).json({ error: 'No addresses found' });
        }

        // Filter by traitType and traitValue if provided
        if (traitType && traitValue) {
            addresses = addresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => {
                    console.log('Checking attribute:', attribute); // Debugging the attributes
                    return attribute.trait_type === traitType && attribute.value === traitValue;
                })
            );
            console.log(`Filtered to ${addresses.length} addresses after traitType and traitValue filtering`); // Debug
        }

        // Filter by fileNamesList if provided
        if (fileNamesList && fileNamesList.length > 0) {
            addresses = addresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
            console.log(`Filtered to ${addresses.length} addresses after fileNamesList filtering`); // Debug
        }

        // If no NFTs are left after filtering
        if (addresses.length === 0) {
            console.log('No NFTs found matching the criteria'); // Debug
            return res.status(404).json({ error: 'No NFTs found matching the criteria' });
        }

        // Select random winners
        console.log('Selecting random winners'); // Debug
        const winners = [];
        const shuffled = addresses.sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, numberOfWinners);

        selected.forEach((winner) => {
            winners.push({
                owner: winner.owner,
                identifier: winner.identifier,
                metadataFileName: winner.metadataFileName,
            });
        });

        // Generate CSV with the snapshot of the draw
        const csvData = addresses.map((item) => ({
            owner: item.owner,
            identifier: item.identifier,
            metadataFileName: item.metadataFileName
        }));

        const csvFilePath = `${__dirname}/snapshot_${Date.now()}.csv`;
        generateCsv(csvData, csvFilePath);

        console.log(`Selected ${winners.length} winners`); // Debug
        res.json({
            winners,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            csvFilePath: csvFilePath // Return CSV file path
        });
    } catch (error) {
        console.error('Error during snapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
