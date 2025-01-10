import { Address } from '@multiversx/sdk-core';
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
const USAGE_FEE = 100; // Fee in REWARD tokens
const REWARD_TOKEN = "REWARD-cf6eac"; // Token identifier
const TREASURY_WALLET = "erd158k2c3aserjmwnyxzpln24xukl2fsvlk9x46xae4dxl5xds79g6sdz37qn"; // Treasury wallet
const provider = new ProxyNetworkProvider("https://gateway.multiversx.com", { clientName: "javascript-api" });

const whitelistFilePath = path.join(__dirname, 'whitelist.json');

app.use(bodyParser.json());  // Parse JSON body

// Middleware to check authorization token for protected routes
const checkToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (token === `Bearer ${SECURE_TOKEN}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Function to validate and return the PEM content from the request body
const getPemContent = (req) => {
    console.log("Request Body:", req.body); // Log the incoming request body for debugging
    const pemContent = req.body.walletPem;
    if (!pemContent || typeof pemContent !== 'string' || !pemContent.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Invalid PEM content');
    }
    return pemContent;
};

// Helper to derive wallet address from PEM
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

// Update `/authorize` endpoint
app.post('/authorize', checkToken, (req, res) => {
    try {
        const pemContent = getPemContent(req);
        const walletAddress = deriveWalletAddressFromPem(pemContent);

        res.json({ message: "Authorization Successful", walletAddress });
    } catch (error) {
        console.error('Error in authorization:', error.message);
        res.status(400).json({ error: error.message });
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
// Example of using the handleUsageFee middleware
app.post('/snapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, numberOfWinners, includeSmartContracts, traitType, traitValue, fileNamesList } = req.body;

        // Fetch NFT owners logic
        const addresses = await fetchNftOwners(collectionTicker, includeSmartContracts);
        if (addresses.length === 0) {
            return res.status(404).json({ error: 'No addresses found' });
        }

        // Filter by traitType and traitValue if provided
        let filteredAddresses = addresses;
        if (traitType && traitValue) {
            filteredAddresses = filteredAddresses.filter((item) =>
                Array.isArray(item.attributes) &&
                item.attributes.some(attribute => attribute.trait_type === traitType && attribute.value === traitValue)
            );
        }

        // Filter by fileNamesList if provided
        if (fileNamesList && fileNamesList.length > 0) {
            filteredAddresses = filteredAddresses.filter((item) =>
                fileNamesList.includes(item.metadataFileName)
            );
        }

        if (filteredAddresses.length === 0) {
            return res.status(404).json({ error: 'No NFTs found matching the criteria' });
        }

        // Select random winners
        const shuffled = filteredAddresses.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners).map(winner => ({
            owner: winner.owner,
            identifier: winner.identifier,
            metadataFileName: winner.metadataFileName,
        }));

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

        // Respond with the winners and stats
        res.json({
            winners,
            uniqueOwnerStats: uniqueOwnerStatsArray,
            message: `${numberOfWinners} winners have been selected from collection ${collectionTicker}.`,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error during snapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch NFT owners
const fetchNftOwners = async (collectionTicker, includeSmartContracts) => {
    const apiProvider = "https://api.multiversx.com";
    let tokensNumber = '0';
    const addressesArr = [];

    const response = await fetch(
        `${apiProvider}/collections/${collectionTicker}/nfts/count`
    );
    tokensNumber = await response.text();

    const makeCalls = () =>
        new Promise((resolve) => {
            const repeats = Math.ceil(Number(tokensNumber) / 100);
            const throttle = pThrottle({
                limit: 2,      // 2 requests per second (per MultiversX API limit)
                interval: 1000 // 1000 ms (1 second)
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
                        metadataFileName: getMetadataFileName(token.attributes), // Extract metadata file name
                        attributes: token.metadata?.attributes || [] // Save full attributes for filtering
                    }));

                    addressesArr.push(addrs);
                    madeRequests++;
                } catch (error) {
                    console.error(`Error in batch ${index}:`, error.message);
                }

                if (madeRequests >= repeats) {
                    resolve(addressesArr.flat());
                }
            });

            for (let step = 0; step < repeats; step++) {
                throttled(step);
            }
        });

    let addresses = await makeCalls();

    if (!includeSmartContracts) {
        addresses = addresses.filter(
            (addrObj) => 
                typeof addrObj.owner === 'string' && !isSmartContractAddress(addrObj.owner)
        );
    }

    return addresses;
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

// Route for SFT snapshot draw
app.post('/sftSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { collectionTicker, editions, numberOfWinners, includeSmartContracts } = req.body;

        if (!collectionTicker || !editions || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: collectionTicker, editions, numberOfWinners' });
        }

        const editionArray = editions.split(',').map(e => e.trim());

        const sftOwners = await fetchSftOwners(collectionTicker, editionArray, includeSmartContracts);
        if (sftOwners.length === 0) {
            return res.status(404).json({ error: 'No SFT owners found for the specified collection and editions' });
        }

        const uniqueOwnerStats = generateUniqueOwnerStats(sftOwners);

        const shuffled = sftOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        res.json({
            winners,
            uniqueOwnerStats,
            totalOwners: sftOwners.length,
            message: `${numberOfWinners} winners have been selected from the SFT collection "${collectionTicker}" across editions "${editions}".`,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error during sftSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to generate unique owner stats
const generateUniqueOwnerStats = (data, isEsdt = false, decimals = 0) => {
    const stats = {};

    data.forEach(({ address, balance }) => {
        const formattedBalance = isEsdt
            ? parseFloat((Number(balance || 0) / 10 ** decimals).toFixed(decimals))
            : 1;

        if (!stats[address]) {
            stats[address] = 0;
        }
        stats[address] += formattedBalance;
    });

    return Object.entries(stats)
        .map(([address, count]) => ({
            owner: address,
            tokensCount: isEsdt ? count.toFixed(decimals) : count,
        }))
        .sort((a, b) => parseFloat(b.tokensCount) - parseFloat(a.tokensCount));
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
// Route for ESDT snapshot draw
app.post('/esdtSnapshotDraw', checkToken, handleUsageFee, async (req, res) => {
    try {
        const { token, includeSmartContracts, numberOfWinners } = req.body;

        if (!token || !numberOfWinners) {
            return res.status(400).json({ error: 'Missing required parameters: token, numberOfWinners' });
        }

        // Fetch token details to get decimals
        const tokenDetails = await fetchTokenDetails(token);
        const decimals = tokenDetails.decimals || 0;

        // Fetch token owners
        const esdtOwners = await fetchEsdtOwners(token, includeSmartContracts);

        if (esdtOwners.length === 0) {
            return res.status(404).json({ error: 'No owners found for the specified token.' });
        }

        // Format balances using decimals
        const formattedOwners = esdtOwners.map(owner => ({
            address: owner.address,
            balance: (Number(BigInt(owner.balanceRaw || 0)) / 10 ** decimals).toFixed(decimals),
        }));

        // Generate unique owner stats with formatted balances
        const uniqueOwnerStats = formattedOwners.reduce((acc, owner) => {
            if (!acc[owner.address]) {
                acc[owner.address] = 0;
            }
            acc[owner.address] += parseFloat(owner.balance);
            return acc;
        }, {});

        const uniqueOwnerStatsArray = Object.entries(uniqueOwnerStats).map(([address, balance]) => ({
            owner: address,
            tokensCount: balance.toFixed(decimals),
        }));

        uniqueOwnerStatsArray.sort((a, b) => parseFloat(b.tokensCount) - parseFloat(a.tokensCount));

        // Randomly select winners from formatted owners
        const shuffled = formattedOwners.sort(() => 0.5 - Math.random());
        const winners = shuffled.slice(0, numberOfWinners);

        res.json({
            token,
            decimals,
            totalOwners: esdtOwners.length,
            uniqueOwnerStats: uniqueOwnerStatsArray,
            winners,
            message: `${numberOfWinners} winners have been selected from the token "${token}".`,
            usageFeeHash: req.usageFeeHash,
        });
    } catch (error) {
        console.error('Error during esdtSnapshotDraw:', error);
        res.status(500).json({ error: error.message });
    }
});

// Helper function to fetch ESDT owners
const fetchEsdtOwners = async (token, includeSmartContracts) => {
    const owners = new Map();
    const size = 1000; // Max batch size
    let from = 0;

    try {
        while (true) {
            const url = `https://api.multiversx.com/tokens/${token}/accounts?size=${size}&from=${from}`;
            const response = await fetch(url);

            if (!response.ok) {
                console.error('API response:', response.status, await response.text());
                throw new Error(`Failed to fetch owners for the specified token.`);
            }

            const data = await response.json();
            if (!data || data.length === 0) {
                break;
            }

            data.forEach(owner => {
                if (includeSmartContracts || !isSmartContractAddress(owner.address)) {
                    owners.set(owner.address, {
                        address: owner.address,
                        balanceRaw: owner.balance,
                    });
                }
            });

            from += size;

            if (owners.size >= 100000) {
                console.warn('Fetched 100,000 unique owners. Stopping further processing.');
                break;
            }
        }

        return Array.from(owners.values());
    } catch (error) {
        console.error('Error fetching ESDT owners:', error.message);
        throw error;
    }
};

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

        res.json({
            winners,
            totalStakedCount,
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
        hodlFounderNFTs: "erd1qqqqqqqqqqqqqpgqpvlxt3n9ks66kuq4j8cvcv25k8a5rsx99g6suw5r66",
    };

    const stakingFunctions = {
        oneDexStakedNfts: "userStake",
        xoxnoStakedNfts: "stake",
        artCpaStakedNfts: "userStake",
        hodlFounderNFT: "stake",
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
            return await response.json();
        };

        const stakedData = await fetchData(
            `https://api.multiversx.com/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&status=success&function=${stakeFunction}`
        );

        const unstakedData = await fetchData(
            `https://api.multiversx.com/accounts/${contractAddress}/transfers?size=1000&token=${collectionTicker}&status=success&function=ESDTNFTTransfer`
        );

        const allTransactions = [...stakedData, ...unstakedData].sort((a, b) => a.timestamp - b.timestamp);

        allTransactions.forEach(tx => {
            const transfers = tx.action?.arguments?.transfers?.filter(
                transfer => transfer.collection === collectionTicker
            ) || [];

            transfers.forEach(item => {
                if (tx.function === stakeFunction) {
                    stakedNfts.set(item.identifier, {
                        owner: tx.sender,
                        identifier: item.identifier
                    });
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
