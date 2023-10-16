const express = require("express");
const { createClient } = require("graphqurl");
const {
  transferNFTs,
  transferArtifact,
  transferRemOnly,
  transferRandomNFT,
  giveWhitelistToken,
  getNftsForOwner,
} = require("./utils/transfer-tokens-api");
const anchor = require("@project-serum/anchor");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const { PublicKey } = require("@solana/web3.js");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 8080;

dayjs.extend(utc);

// app.use(express.json());
let pendingRestaking = [];
let badMissionHistory = [];
let badMissionHistoryIDs = [];
let pendingCompletedHistory = [];
let pendingCompletedHistoryIDs = [];
let cancelVerifyHistory = [];
let cancelVerifyHistoryIDs = [];

const MISSION_KEY = {
  staking: {
    requirements: () => true,
    reward: 8,
    earningCycle: 24,
    cancelPenalty: 0,
    name: "Staking",
    lossText: null,
    drops: null,
  }
};

const connection = new anchor.web3.Connection(process.env.SOLANA_RPC_HOST, {
  commitment: "confirmed",
  // 120seconds aka two mins.
  confirmTransactionInitialTimeout: 1000 * 60,
});

const API_URI ="https://omens-staking.herokuapp.com/v1/graphql"

const client = createClient({
  endpoint: API_URI,
  headers: {
    "x-hasura-admin-secret": `${process.env.HASURA_SECRET}`,
  },
});

const restakeMission = (mission) => {
  const diffBetweenLast = dayjs
    .utc(mission.extract_at)
    .diff(dayjs.utc(mission.started_at), "h");

  console.log("Mission Drop Length", MISSION_KEY[mission.type]?.drops?.length);
  return (
    transferRemOnly(mission.wallet, mission.reward, connection)
  ).then((txHash) => {
    if (txHash === "invalid") {
      return txHash;
    }
    return client
      .query({
        // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
        query: `
        mutation updateMissions(
          $where: missions_bool_exp!
          $_set: missions_set_input
        ) {
          update_missions(where: $where, _set: $_set) {
            returning {
              id
              reward
              wallet
              started_at
              extract_at
              mints
              status
              transactions
            }
          }
        }
      `,
        variables: {
          where: {
            id: {
              _eq: mission.id,
            },
          },
          _set: {
            transactions: [
              ...mission.transactions,
              {
                tx: txHash,
                tx_info: "Restake Reward",
              },
            ],
            started_at: dayjs.utc().toISOString(),
            extract_at: dayjs
              .utc()
              .add(Math.abs(diffBetweenLast), "h")
              .toISOString(),
          },
        },
      })
      .then(() => {
        console.log("Successful Restake ", txHash);
        return txHash;
      });
  });
};

// const handleDrop = async (mission) => {
//   const dropRewards = MISSION_KEY[mission.type].drops;
//   console.log("handleDrop", dropRewards);
//   let ticketNumber = 1;
//   if (dropRewards) {
//     const tickets = dropRewards.map((reward) => ({
//       type: reward.type,
//       tickets: new Array(reward.chance * 1000).fill(0).map((_, i) => {
//         return ticketNumber++;
//       }),
//     }));

//     const winningTicket = Math.floor(Math.random() * 1000);

//     const winningChoice = tickets.filter(
//       (reward) => reward.tickets.indexOf(winningTicket) !== -1
//     );

//     console.log(winningTicket, winningChoice[0]);

//     return DROP_LOGIC[winningChoice[0].type].handle(mission.wallet);
//   }
//   console.log("Handle empty");
//   return "";
// };

const generateCurrentReward = (mission) => {
  const timeSince = Math.abs(dayjs.utc(mission.started_at).diff(dayjs(), "s"));
  const perSecond =
    MISSION_KEY[mission.type].reward /
    (MISSION_KEY[mission.type].earningCycle * 3600);
  const rewardPrePen = timeSince * perSecond;
  const reward = parseFloat(
    (
      rewardPrePen -
      rewardPrePen * MISSION_KEY[mission.type].cancelPenalty
    ).toFixed(3)
  );
  // Make sure they never make over 9 if they cancel right before.
  return reward > MISSION_KEY[mission.type].reward
    ? MISSION_KEY[mission.type].reward
    : reward;
};

const sendBack = (mission, canceled) => {
  // WE are gonna send back each mint from the staking wallet back to the user, and set status to completed
  const hypotheticalReward = canceled
    ? generateCurrentReward(mission)
    : mission.reward;

  return transferNFTs(
    mission.mints.map((m) => m.mint),
    mission.wallet,
    hypotheticalReward,
    connection
  )
    .then((txHash) => {
      if (!canceled && MISSION_KEY[mission.type]?.drops?.length > 0) {
        return client.query({
            // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
            query: `
          mutation updateMissions(
            $where: missions_bool_exp!
            $_set: missions_set_input
          ) {
            update_missions(where: $where, _set: $_set) {
              returning {
                id
                reward
                wallet
                started_at
                extract_at
                mints
                type
                status
                transactions
              }
            }
          }
        `,
          variables: {
            where: {
              id: {
                _eq: mission.id,
              },
            },
            _set: {
              transactions: [
                ...mission.transactions.filter((r) =>
                  r.tx_info !== canceled
                    ? "Staking Canceled"
                    : "Staking Complete"
                ),
                {
                  tx: txHash,
                  tx_info: canceled
                    ? "Staking Canceled"
                    : "Staking Complete",
                },
              ],
              ...(canceled ? { reward: hypotheticalReward } : {}),
            },
          },
        })
        .then((data) => {
          console.log("Successful transfer ", txHash);
          return txHash;
        })
        .catch(console.log);
      }
      return client
        .query({
          // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
          query: `
            mutation updateMissions(
              $where: missions_bool_exp!
              $_set: missions_set_input
            ) {
              update_missions(where: $where, _set: $_set) {
                returning {
                  id
                  reward
                  wallet
                  started_at
                  extract_at
                  mints
                  type
                  status
                  transactions
                }
              }
            }
          `,
          variables: {
            where: {
              id: {
                _eq: mission.id,
              },
            },
            _set: {
              transactions: [
                ...mission.transactions.filter((r) =>
                  r.tx_info !== canceled
                    ? "Staking Canceled"
                    : "Staking Complete"
                ),
                {
                  tx: txHash,
                  tx_info: canceled ? "Staking Canceled" : "Staking Complete",
                },
              ],
              ...(canceled ? { reward: hypotheticalReward } : {}),
            },
          },
        })
        .then((data) => {
          console.log("Successful transfer ", txHash);
          return txHash;
        })
        .catch(console.log);
    })
    .catch((err) => {
      return client
        .query({
          query: `
          mutation updateMissions(
            $where: missions_bool_exp!
            $_set: missions_set_input
          ) {
            update_missions(where: $where, _set: $_set) {
              returning {
                id
                reward
                wallet
                started_at
                extract_at
                transactions
                mints
                type
                status
                transactions
              }
            }
          }
        `,
          variables: {
            where: {
              id: {
                _eq: mission.id,
              },
            },
            _set: {
              status: canceled ? "cancel-pending" : "staking",
            },
          },
        })
        .then(() => {
          console.log("failed cron task to transfer back", err);
          return "";
        });
    });
};


const restakedHandling = async () => {
  try {
    return client
    .query({
      // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
      query: `
          query findExpiredRestaked(
            $where: missions_bool_exp!
          ) {
            missions(where: $where) {
                id
                reward
                wallet
                started_at
                extract_at
                transactions
                mints
                status
                type
              
            }
          }
        `,
      variables: {
        where: {
          _and: [
            {
              extract_at: {
                _lt: "now()",
              },
            },
            {
              status: {
                _eq: "restaking",
              },
            },
          ],
        },
      },
    })
    .then(async ({ data: { missions: _m } }) => {
      const missions = _m.filter((m) => !pendingRestaking.includes(_m));
      if (missions.length > 0) {
        pendingRestaking.push(missions.map((m) => m.id));
        console.log(`[restaked] Restake Check: ${missions.length} missions`);
        const signatures = await Promise.all(
          missions.map((m) => restakeMission(m))
        );
        pendingRestaking = pendingRestaking.filter(
          (id) => !missions.map((m) => m.id).includes(id)
        );
        // return res.json({
        //   ok: true,
        //   signatures,
        // });
      } else {
        console.log(`[restaked] No missions restaking`);
        // return res.json({ ok: true });
      }
    })
    .catch((e) => {
      console.log(e);
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

const stakedHandling = async () => {
  try {
    return client
    .query({
      // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
      query: `
          mutation updatedExpiredMissions(
            $where: missions_bool_exp!
            $_set: missions_set_input
          ) {
            update_missions(where: $where, _set: $_set) {
              returning {
                id
                reward
                wallet
                started_at
                extract_at
                transactions
                mints
                status
                type
              }
            }
          }
        `,
      variables: {
        where: {
          _and: [
            {
              extract_at: {
                _lt: "now()",
              },
            },
            {
              status: {
                _eq: "staking",
              },
            },
          ],
        },
        _set: {
          status: "pending-complete",
        },
      },
    })
    .then(
      async ({
        data: {
          update_missions: { returning: missions },
        },
      }) => {
        if (missions.length > 0) {
          console.log(
            `[staked] Completion Check: ${missions.length} missions`
          );
          const signatures = await Promise.all(
            missions.map((m) => sendBack(m, false))
          );
          // return res.json({
          //   ok: true,
          //   signatures,
          // });
        } else {
          console.log(`[staked] No missions completed`);

          // return res.json({ ok: true });
        }
      }
    )
    .catch((e) => {
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

const canceledHandling = async () => {
  try {
    return client
    .query({
      // TODO Investigate if we just did a mutation to set staking to completed on to fulfil mission items, if its better to then just process after the mutation result.
      query: `
          mutation returnCanceledMissions(
            $where: missions_bool_exp!
            $_set: missions_set_input
          ) {
            update_missions(where: $where, _set: $_set) {
              returning {
                id
                reward
                wallet
                started_at
                extract_at
                transactions
                mints
                type
                status
              }
            }
          }
        `,
      variables: {
        where: {
          status: {
            _eq: "cancel-pending",
          },
        },
        _set: {
          status: "cancel-verify",
        },
      },
    })
    .then(
      async ({
        data: {
          update_missions: { returning: missions },
        },
      }) => {
        if (missions.length > 0) {
          console.log(`[canceled] Missions Canceled: ${missions.length}`);
          const signatures = await Promise.all(
            missions.map((m) => sendBack(m, true)),
            true
          );
          // console.log(signatures);
          // // return res.json({
          //   ok: true,
          //   signatures,
          // });
        } else {
          console.log(`[canceled] No missions canceled`);
          // return res.json({ ok: true });
        }
      }
    )
    .catch((e) => {
      console.log(e);
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

const pendingHandling = async () => {
  try {
    return client
    .query({
      query: `
    query pendingMissions(
      $where: missions_bool_exp
    ) {
      missions(where: $where) {
          id
          reward
          wallet
          started_at
          extract_at
          transactions
          mints
          status
          type
      }
    }`,
      variables: {
        where: {
          status: {
            _eq: "pending",
          },
        },
      },
    })
    .then(async ({ data: { missions } }) => {
      console.log(
        `[pending] Pending Missions Check: ${missions.length} missions`
      );
      const badMissions = [];
      const goodMissions = [];
      for (const mission of missions) {
        const startedTX = mission.transactions.filter(
          (tx) => tx.tx_info === "Staking Started"
        )?.[0];

        const result = await connection.getTransaction(startedTX?.tx);
        if (result) {
          if (result?.meta?.err === null) {
            // Filter non bads just incase.
            badMissionHistoryIDs = badMissionHistoryIDs.filter(
              (id) => id !== mission.id
            );
            badMissionHistory = badMissionHistory.filter(
              (m) => m?.mission?.id !== mission.id
            );
            // Add to completed
            goodMissions.push(mission.id);
          }
        } else {
          if (badMissionHistoryIDs.indexOf(mission.id) === -1) {
            badMissionHistoryIDs.push(mission.id);
            badMissionHistory.push({ mission, count: 1 });
          } else {
            const bad = badMissionHistory.filter(
              (bm) => bm?.mission?.id === mission?.id
            )?.[0];
            // 3mins to succeed
            if (bad?.count + 1 >= 3) {
              badMissions.push(mission.id);
              badMissionHistoryIDs = badMissionHistoryIDs.filter(
                (id) => id !== mission?.id
              );
              badMissionHistory = badMissionHistory.filter(
                (m) => m?.mission?.id !== mission?.id
              );
            } else {
              badMissionHistory = [
                ...badMissionHistory.filter(
                  (m) => m?.mission?.id !== mission.id
                ),
                { mission, count: (bad?.count || 0) + 1 },
              ];
            }
          }
        }
      }

      console.log(
        `[pending] Deleting ${badMissions.length}, pausing on ${badMissionHistory.length} bad, confirming ${goodMissions.length} good`
      );

      return client.query({
        query: `
        mutation updateFailedMissions($whereBad: missions_bool_exp!, $setBad: missions_set_input, $whereGood: missions_bool_exp!, $setGood: missions_set_input) {
          badUpdates: update_missions(where: $whereBad, _set: $setBad) {
            returning {
              id
            }
          }
          goodUpdates: update_missions(where: $whereGood, _set: $setGood) {
            returning {
              id
            }
          }
        }
      `,
        variables: {
          whereBad: {
            id: {
              _in: badMissions,
            },
          },
          setBad: {
            status: "canceled",
          },
          whereGood: {
            id: {
              _in: goodMissions,
            },
          },
          setGood: {
            status: "restaking",
          },
        },
      });
    })
    .then((resp) => {
      // if (resp.err) {
      //   return res.json({ ok: false, err });
      // } else {
      //   return res.json({ ok: true, data: resp.data });
      // }
      // console.log(resp)
    })
    .catch((e) => {
      console.log("[pending] caught failure on gql: ", e);
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

const stakePendingHandling = async () => {
  try {
    return client
    .query({
      query: `
    query pendingMissions(
      $where: missions_bool_exp
    ) {
      missions(where: $where) {
          id
          reward
          wallet
          started_at
          extract_at
          transactions
          mints
          status
          type
      }
    }`,
      variables: {
        where: {
          status: {
            _eq: "pending-complete",
          },
        },
      },
    })
    .then(async ({ data: { missions } }) => {
      console.log(
        `[stake_pending] Checking Pending Withdraws: ${missions.length} missions`
      );
      const badMissions = [];
      const goodMissions = [];
      for (const mission of missions) {
        const completedTx = mission.transactions.filter(
          (tx) => tx.tx_info === "Staking Complete" && tx.tx !== "invalid"
        )?.[0];

        if (!!completedTx && !!completedTx?.tx) {
          const result = await connection
            .getTransaction(completedTx?.tx)
            .catch((e) => {
              console.log(" - Failed getting TX");
            });
          if (result) {
            if (result?.meta?.err === null) {
              // Filter non bads just incase.
              pendingCompletedHistoryIDs = pendingCompletedHistoryIDs.filter(
                (id) => id !== mission.id
              );
              pendingCompletedHistory = pendingCompletedHistory.filter(
                (m) => m?.mission?.id !== mission.id
              );
              // Add to completed
              goodMissions.push({ ...mission, status: "completed" });
            }
          } else {
            if (pendingCompletedHistoryIDs.indexOf(mission.id) === -1) {
              pendingCompletedHistoryIDs.push(mission.id);
              pendingCompletedHistory.push({ mission, count: 1 });
            } else {
              const bad = pendingCompletedHistory.filter(
                (bm) => bm?.mission?.id === mission?.id
              )?.[0];
              // 3mins to succeed
              if (bad?.count + 1 >= 3) {
                badMissions.push({
                  ...mission,
                  status: "staking",
                  transactions: mission.transactions.filter(
                    (tx) => tx.tx_info !== "Staking Complete"
                  ),
                });
                pendingCompletedHistoryIDs =
                  pendingCompletedHistoryIDs.filter(
                    (id) => id !== mission?.id
                  );
                pendingCompletedHistory = pendingCompletedHistory.filter(
                  (m) => m?.mission?.id !== mission?.id
                );
              } else {
                pendingCompletedHistory = [
                  ...pendingCompletedHistory.filter(
                    (m) => m?.mission?.id !== mission.id
                  ),
                  { mission, count: (bad?.count || 0) + 1 },
                ];
              }
            }
          }
        } else {
          if (pendingCompletedHistoryIDs.indexOf(mission.id) === -1) {
            pendingCompletedHistoryIDs.push(mission.id);
            pendingCompletedHistory.push({ mission, count: 1 });
          } else {
            const bad = pendingCompletedHistory.filter(
              (bm) => bm?.mission?.id === mission?.id
            )?.[0];
            // 3mins to succeed
            if (bad?.count + 1 >= 3) {
              badMissions.push({
                ...mission,
                status: "staking",
                transactions: mission.transactions.filter(
                  (tx) => tx.tx_info !== "Staking Complete"
                ),
              });
              pendingCompletedHistoryIDs = pendingCompletedHistoryIDs.filter(
                (id) => id !== mission?.id
              );
              pendingCompletedHistory = pendingCompletedHistory.filter(
                (m) => m?.mission?.id !== mission?.id
              );
            } else {
              pendingCompletedHistory = [
                ...pendingCompletedHistory.filter(
                  (m) => m?.mission?.id !== mission.id
                ),
                { mission, count: (bad?.count || 0) + 1 },
              ];
            }
          }
        }
      }

      console.log(
        `[stake_pending] Retrying ${badMissions.length}, pausing on ${pendingCompletedHistory.length} bad, updating ${goodMissions.length} good`
      );

      return client.query({
        query: `
        mutation updateFailedMissions($objects: [missions_insert_input!]!) {
          insert_missions(objects: $objects, on_conflict: { constraint: mint_pkey, update_columns: [
            id
            transactions
            status
          ]}) {
            returning {
              id
              status
              transactions
            }
          }
        }
      `,
        variables: {
          objects: [...goodMissions, ...badMissions],
        },
      });
    })
    .then((resp) => {
      // if (resp.err) {
      //   return res.json({ ok: false, err });
      // } else {
      //   return res.json({ ok: true, data: resp.data });
      // }
      // console.log(resp)
    })
    .catch((e) => {
      console.log("[stake_pending] caught failure on gql: ", e);
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

const cancelVerifyHandling = async () => {
  try {
    return client
    .query({
      query: `
  query pendingMissions(
    $where: missions_bool_exp
  ) {
    missions(where: $where) {
        id
        reward
        wallet
        started_at
        extract_at
        transactions
        mints
        status
        type
    }
  }`,
      variables: {
        where: {
          status: {
            _eq: "cancel-verify",
          },
        },
      },
    })
    .then(async ({ data: { missions } }) => {
      console.log(
        `[cancel_verify] Verifying Cancelations: ${missions.length} missions`
      );
      const badMissions = [];
      const goodMissions = [];
      for (const mission of missions) {
        const completedTx = mission.transactions.filter(
          (tx) => tx.tx_info === "Staking Canceled" && tx.tx !== "invalid"
        )?.[0];

        if (!!completedTx && !!completedTx?.tx) {
          const result = await connection
            .getTransaction(completedTx?.tx)
            .catch((e) => {
              console.log(" - Failed getting TX");
            });
          if (result) {
            if (result?.meta?.err === null) {
              // Filter non bads just incase.
              cancelVerifyHistoryIDs = cancelVerifyHistoryIDs.filter(
                (id) => id !== mission.id
              );
              cancelVerifyHistory = cancelVerifyHistory.filter(
                (m) => m?.mission?.id !== mission.id
              );
              // Add to completed
              goodMissions.push({ ...mission, status: "canceled" });
            }
          } else {
            if (cancelVerifyHistoryIDs.indexOf(mission.id) === -1) {
              cancelVerifyHistoryIDs.push(mission.id);
              cancelVerifyHistory.push({ mission, count: 1 });
            } else {
              const bad = cancelVerifyHistory.filter(
                (bm) => bm?.mission?.id === mission?.id
              )?.[0];
              // 3mins to succeed
              if (bad?.count + 1 >= 3) {
                badMissions.push({
                  ...mission,
                  status: "cancel-pending",
                  reward: MISSION_KEY[mission.type].reward,
                  transactions: mission.transactions.filter(
                    (tx) => tx.tx_info !== "Staking Canceled"
                  ),
                });
                cancelVerifyHistoryIDs = cancelVerifyHistoryIDs.filter(
                  (id) => id !== mission?.id
                );
                cancelVerifyHistory = cancelVerifyHistory.filter(
                  (m) => m?.mission?.id !== mission?.id
                );
              } else {
                cancelVerifyHistory = [
                  ...cancelVerifyHistory.filter(
                    (m) => m?.mission?.id !== mission.id
                  ),
                  { mission, count: (bad?.count || 0) + 1 },
                ];
              }
            }
          }
        } else {
          if (cancelVerifyHistoryIDs.indexOf(mission.id) === -1) {
            cancelVerifyHistoryIDs.push(mission.id);
            cancelVerifyHistory.push({ mission, count: 1 });
          } else {
            const bad = cancelVerifyHistory.filter(
              (bm) => bm?.mission?.id === mission?.id
            )?.[0];
            // 3mins to succeed
            if (bad?.count + 1 >= 3) {
              badMissions.push({
                ...mission,
                status: "cancel-pending",
                reward: MISSION_KEY[mission.type].reward,
                transactions: mission.transactions.filter(
                  (tx) => tx.tx_info !== "Staking Canceled"
                ),
              });
              cancelVerifyHistoryIDs = cancelVerifyHistoryIDs.filter(
                (id) => id !== mission?.id
              );
              cancelVerifyHistory = cancelVerifyHistory.filter(
                (m) => m?.mission?.id !== mission?.id
              );
            } else {
              cancelVerifyHistory = [
                ...cancelVerifyHistory.filter(
                  (m) => m?.mission?.id !== mission.id
                ),
                { mission, count: (bad?.count || 0) + 1 },
              ];
            }
          }
        }
      }

      console.log(
        `[cancel_verify] Retrying ${badMissions.length}, pausing on ${cancelVerifyHistory.length} bad, updating ${goodMissions.length} good`
      );

      console.log("bad missions", badMissions);
      console.log("good missions", goodMissions);

      return client.query({
        query: `
      mutation updateFailedMissions($objects: [missions_insert_input!]!) {
        insert_missions(objects: $objects, on_conflict: { constraint: mint_pkey, update_columns: [
          id
          transactions
          status
        ]}) {
          returning {
            id
            status
            transactions
          }
        }
      }
    `,
        variables: {
          objects: [...goodMissions, ...badMissions],
        },
      });
    })
    .then((resp) => {
      // if (resp.err) {
      //   return res.json({ ok: false, err });
      // } else {
      //   return res.json({ ok: true, data: resp.data });
      // }
      // console.log(resp)
    })
    .catch((e) => {
      console.log("[cancel_verify] caught failure on gql: ", e);
      // return res.json({ ok: false, e });
    });
  } catch (error) {
    console.log(error)
  }
};

var intervalVar =  setInterval(processHandling, 5000);

async function processHandling() {
  clearInterval(intervalVar);

  await pendingHandling();

  await stakedHandling();

  await stakePendingHandling();

  await restakedHandling();

  await canceledHandling();

  await cancelVerifyHandling();  

  intervalVar =  setInterval(processHandling, 5000);
}

app.listen(port, function (err) {
  if (err) console.log(err);
  console.log("Server listening on PORT", port);
});
