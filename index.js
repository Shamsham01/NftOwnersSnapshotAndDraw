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

    const response = await fetch(
        `${apiProvider.mainnet}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();

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

                const addrs = data.map((token) => ({
                    owner: token.owner,
                    identifier: token.identifier,
                    metadataFileName: getMetadataFileName(token.attributes),  // Extract metadata file name
                    attributes: token.attributes  // Save full attributes for filtering
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

    // Filter out smart contracts if includeSmartContracts is false
    if (!includeSmartContracts) {
        addresses = addresses.filter(
            (addrObj) => 
                typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addresses;
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
        let addresses = await fetchNftOwners(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
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
        }

        // Filter by fileNamesList if provided
        if (fileNamesList && fileNamesList.length > 0) {
            addresses = addresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        // If no NFTs are left after filtering
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria' });
        }

        // Select random winners
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

        res.json({
            winners,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
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
