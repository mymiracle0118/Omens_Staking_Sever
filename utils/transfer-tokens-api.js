const anchor = require("@project-serum/anchor");
const splToken = require("@solana/spl-token");
const { LAMPORTS_PER_SOL, PublicKey } = require("@solana/web3.js");
const { default: axios } = require("axios");
const { decodeMetadata } = require("./metadata");
require("dotenv").config();

const TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);
// @ts-ignore
const WALLET_SECRET_KEY = new Uint8Array(
  process.env.SECRET_KEY.split(",").map((m) => parseInt(m))
);
const FIVE_SOL_WALLET_SECRET_KEY = new Uint8Array(
  process.env.FIVE_SOL_WALLET.split(",").map((m) => parseInt(m))
);
const ONE_SOL_WALLET_SECRET_KEY = new Uint8Array(
  process.env.ONE_SOL_WALLET.split(",").map((m) => parseInt(m))
);
const ARTIFACT_WALLET_SECRET_KEY = new Uint8Array(
  process.env.ARTIFACTS_WALLET.split(",").map((m) => parseInt(m))
);

const LAMPORTS_PER_STYX = 1000;

const fromWallet = anchor.web3.Keypair.fromSecretKey(WALLET_SECRET_KEY);

const nft5SolWallet = anchor.web3.Keypair.fromSecretKey(
  FIVE_SOL_WALLET_SECRET_KEY
);
const nft1SolWallet = anchor.web3.Keypair.fromSecretKey(
  ONE_SOL_WALLET_SECRET_KEY
);
const artifactWallet = anchor.web3.Keypair.fromSecretKey(
  ARTIFACT_WALLET_SECRET_KEY
);

const getNftsForOwner = async (connection, ownerAddress) => {
  const allTokens = [];
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    ownerAddress,
    {
      programId: splToken.TOKEN_PROGRAM_ID,
    }
  );

  for (let index = 0; index < tokenAccounts.value.length; index++) {
    try {
      const tokenAccount = tokenAccounts.value[index];
      const tokenAmount = tokenAccount.account.data.parsed.info.tokenAmount;

      if (tokenAmount.amount == "1" && tokenAmount.decimals == "0") {
        let [pda] = await anchor.web3.PublicKey.findProgramAddress(
          [
            Buffer.from("metadata"),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            new anchor.web3.PublicKey(
              tokenAccount.account.data.parsed.info.mint
            ).toBuffer(),
          ],
          TOKEN_METADATA_PROGRAM_ID
        );

        const accountInfo = await connection.getParsedAccountInfo(pda);

        if (accountInfo && accountInfo.value) {
          const metadata = decodeMetadata(accountInfo.value.data);
          // console.log(metadata.data.uri);
          const { data } = await axios.get(metadata.data.uri);
          allTokens.push({
            ...data,
            mint: tokenAccount.account.data.parsed.info.mint,
          });
        }
      }
    } catch (e) {
      console.error(
        e,
        tokenAccounts.value[index].account.data.parsed.info.mint
      );
    }
  }

  return allTokens;
};

const transferRandomNFT = async (wallet, type, connection, client) => {
  const toWallet = new PublicKey(wallet);
  const transaction = new anchor.web3.Transaction();

  const nftsForOwner = await getNftsForOwner(
    connection,
    type === "nft_1_sol" ? nft1SolWallet.publicKey : nft5SolWallet.publicKey
  );
  const allNFTs = nftsForOwner;

  const hasSome = allNFTs.length > 0;

  if (hasSome) {
    const randomNFT = allNFTs[Math.floor(Math.random() * allNFTs.length - 1)];

    const myMint = new PublicKey(randomNFT.mint);
    const myToken = new splToken.Token(
      connection,
      myMint,
      splToken.TOKEN_PROGRAM_ID,
      type === "nft_1_sol" ? nft1SolWallet : nft5SolWallet
    );

    const fromTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
      type === "nft_1_sol" ? nft1SolWallet.publicKey : nft5SolWallet.publicKey
    );

    const toTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
      toWallet
    );

    transaction.add(
      splToken.Token.createTransferInstruction(
        splToken.TOKEN_PROGRAM_ID,
        fromTokenAccount.address,
        toTokenAccount.address,
        type === "nft_1_sol"
          ? nft1SolWallet.publicKey
          : nft5SolWallet.publicKey,
        [],
        1
      )
    );

    return anchor.web3
      .sendAndConfirmTransaction(
        connection,
        transaction,
        [type === "nft_1_sol" ? nft1SolWallet : nft5SolWallet],
        {
          skipPreflight: true,
          commitment: "processed",
        }
      )
      .then((signature) => {
        return signature || "invalid";
      })
      .catch(async (e) => {
        const message = e.message;
        if (message.includes("Check signature")) {
          const parts = message.split("Check signature");
          console.log("Invalid signature, ", parts[1].trim().split(" ")[0]);
          const result = await connection.getTransaction(
            parts[1].trim().split(" ")[0]
          );
          if (result) {
            if (result?.meta?.err === null) {
              return parts[1].trim().split(" ")[0];
            }
          } else {
            return "invalid";
          }
          return parts[1].trim().split(" ")[0];
        } else {
          // console.log(
          //   mints.map((m) => m.mint),
          //   message
          // );
          return "invalid";
        }
      });
  } else {
    return client
      .query({
        query: `
        mutation insertWhitelistSpot(
          $objects: [whitelist_spots_insert_input!]!
        ) {
          insert_whitelist_spots(objects: $objects) {
            returning {
              id
            }
          }
        }
      `,
        variables: {
          objects: [
            {
              wallet,
              type,
            },
          ],
        },
      })
      .then(() => {
        return "spot_reserved";
      })
      .catch(() => {
        return "spot_failed";
      });
  }
};

const transferArtifact = async (wallet, type, connection) => {
  const toWallet = new PublicKey(wallet);
  const transaction = new anchor.web3.Transaction();

  const metadataFilters = {
    chalice_of_midas: "Chalice of Midas",
    lyre_of_orpheus: "Lyre of Orpheus",
  };

  const nftsForOwner = await getNftsForOwner(
    connection,
    artifactWallet.publicKey
  );
  const allArtifacts = nftsForOwner.filter((nft) => nft.symbol === "OART");

  const artifactOfDroppedType = allArtifacts.filter(
    (a) =>
      a.attributes.filter((a) => a.trait_type === metadataFilters[type])
        .length > 0
  );
  const hasOfType = artifactOfDroppedType.length > 0;

  if (hasOfType) {
    const randomArtifact =
      artifactOfDroppedType[
        Math.floor(Math.random() * artifactOfDroppedType.length - 1)
      ];

    const myMint = new PublicKey(randomArtifact.mint);
    const myToken = new splToken.Token(
      connection,
      myMint,
      splToken.TOKEN_PROGRAM_ID,
      artifactWallet
    );

    const fromTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
      artifactWallet.publicKey
    );

    const toTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
      toWallet
    );

    transaction.add(
      splToken.Token.createTransferInstruction(
        splToken.TOKEN_PROGRAM_ID,
        fromTokenAccount.address,
        toTokenAccount.address,
        artifactWallet.publicKey,
        [],
        1
      )
    );

    return anchor.web3
      .sendAndConfirmTransaction(connection, transaction, [artifactWallet], {
        skipPreflight: true,
        commitment: "processed",
      })
      .then((signature) => {
        return signature || "invalid";
      })
      .catch(async (e) => {
        const message = e.message;
        if (message.includes("Check signature")) {
          const parts = message.split("Check signature");
          console.log("Invalid signature, ", parts[1].trim().split(" ")[0]);
          const result = await connection.getTransaction(
            parts[1].trim().split(" ")[0]
          );
          if (result) {
            if (result?.meta?.err === null) {
              return parts[1].trim().split(" ")[0];
            }
          } else {
            return "invalid";
          }
          return parts[1].trim().split(" ")[0];
        } else {
          console.log(
            mints.map((m) => m.mint),
            message
          );
          return "invalid";
        }
      });
  } else {
    // Handle out of type of artifacts do what?
    return false;
  }
};

const giveWhitelistToken = async (wallet, type, client) => {
  return client
    .query({
      // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
      query: `
        mutation insertWhitelistSpot(
          $objects: [whitelist_spots_insert_input!]!
        ) {
          insert_whitelist_spots(objects: $objects) {
            returning {
              id
            }
          }
        }
      `,
      variables: {
        objects: [
          {
            wallet,
            type,
          },
        ],
      },
    })
    .then(() => {
      return "spot_reserved";
    })
    .catch(() => {
      return "spot_failed";
    });
};

const transferRemOnly = async (wallet, amount, connection) => {
  const toWallet = new PublicKey(wallet);
  const transaction = new anchor.web3.Transaction();

  if (amount > 0) {
    const guardToken = new splToken.Token(
      connection,
      new PublicKey(process.env.TOKEN_ADDRESS),
      splToken.TOKEN_PROGRAM_ID,
      fromWallet
    );

    const fromTokenAccount = await guardToken.getOrCreateAssociatedAccountInfo(
      fromWallet.publicKey
    );
    const toTokenAccount = await guardToken.getOrCreateAssociatedAccountInfo(
      toWallet
    );

    transaction.add(
      splToken.Token.createTransferInstruction(
        splToken.TOKEN_PROGRAM_ID,
        fromTokenAccount.address,
        toTokenAccount.address,
        fromWallet.publicKey,
        [],
        amount * LAMPORTS_PER_STYX
      )
    );
  }

  return anchor.web3
    .sendAndConfirmTransaction(connection, transaction, [fromWallet], {
      skipPreflight: true,
      commitment: "processed",
    })
    .then((signature) => {
      return signature || "invalid";
    })
    .catch(async (e) => {
      const message = e.message;
      if (message.includes("Check signature")) {
        const parts = message.split("Check signature");
        console.log("Invalid signature, ", parts[1].trim().split(" ")[0]);
        const result = await connection.getTransaction(
          parts[1].trim().split(" ")[0]
        );
        if (result) {
          if (result?.meta?.err === null) {
            return parts[1].trim().split(" ")[0];
          }
        } else {
          return "invalid";
        }
        return parts[1].trim().split(" ")[0];
      } else {
        console.log(
          mints.map((m) => m.mint),
          message
        );
        return "invalid";
      }
    });
};

const transferNFTs = async (mints, wallet, amount, connection) => {
  const toWallet = new PublicKey(wallet);
  const transaction = new anchor.web3.Transaction();

  for await (const mint of mints) {
    const myMint = new PublicKey(mint);
    const myToken = new splToken.Token(
      connection,
      myMint,
      splToken.TOKEN_PROGRAM_ID,
      fromWallet
    );

    // const fromTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
    //   fromWallet.publicKey
    // );

    const toTokenAccount = await myToken.getOrCreateAssociatedAccountInfo(
      toWallet
    );

    const res = await fetch(process.env.SOLANA_RPC_HOST, {
      body: `{
          "jsonrpc":"2.0", 
          "id":1, 
          "method":"getProgramAccounts", 
          "params":[
            "${splToken.TOKEN_PROGRAM_ID}",
            {
              "encoding": "jsonParsed",
              "filters": [
                {
                  "dataSize": 165
                },
                {
                  "memcmp": {
                    "offset": 0,
                    "bytes": "${mint}"
                  }
                }
              ]
            }
          ]}
      `,
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const json = await res.json();
    const validAccount = json.result.filter((r) => {
      return r.account.data.parsed.info.tokenAmount.uiAmount > 0;
    })[0].pubkey;

    transaction.add(
      splToken.Token.createTransferInstruction(
        splToken.TOKEN_PROGRAM_ID,
        new PublicKey(validAccount),
        toTokenAccount.address,
        fromWallet.publicKey,
        [],
        1
      )
    );

    // transaction.add(
    //   splToken.Token.createSetAuthorityInstruction(
    //     splToken.TOKEN_PROGRAM_ID,
    //     new PublicKey(validAccount),
    //     new PublicKey(wallet),
    //     "AccountOwner",
    //     fromWallet.publicKey,
    //     []
    //   )
    // );
  }
  if (amount > 0) {
    const guardToken = new splToken.Token(
      connection,
      new PublicKey(process.env.TOKEN_ADDRESS),
      splToken.TOKEN_PROGRAM_ID,
      fromWallet
    );

    const fromTokenAccount = await guardToken.getOrCreateAssociatedAccountInfo(
      fromWallet.publicKey
    );
    const toTokenAccount = await guardToken.getOrCreateAssociatedAccountInfo(
      toWallet
    );

    transaction.add(
      splToken.Token.createTransferInstruction(
        splToken.TOKEN_PROGRAM_ID,
        fromTokenAccount.address,
        toTokenAccount.address,
        fromWallet.publicKey,
        [],
        amount * LAMPORTS_PER_STYX
      )
    );
  }

  return anchor.web3
    .sendAndConfirmTransaction(connection, transaction, [fromWallet], {
      skipPreflight: true,
      commitment: "processed",
    })
    .then((signature) => {
      return signature || "invalid";
    })
    .catch((e) => {
      const message = e.message;
      if (message.includes("Check signature")) {
        const parts = message.split("Check signature");
        console.log("Invalid signature, ", parts[1].trim().split(" ")[0]);
        return parts[1].trim().split(" ")[0];
      } else {
        console.log(
          mints.map((m) => m.mint),
          message
        );
        return "invalid";
      }
    });
};

module.exports = {
  transferNFTs,
  transferRemOnly,
  transferArtifact,
  transferRandomNFT,
  giveWhitelistToken,
  getNftsForOwner,
};
