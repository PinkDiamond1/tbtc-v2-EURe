import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction, BigNumber, BigNumberish } from "ethers"
import type { FakeContract } from "@defi-wonderland/smock"
import { smock } from "@defi-wonderland/smock"
import { to1ePrecision } from "../helpers/contract-test-helpers"

import { ecdsaWalletTestData } from "../data/ecdsa"
import type {
  BridgeStub,
  IWalletRegistry,
  Bank,
  BankStub,
  MaintainerProxy,
  ReimbursementPool,
  Bridge,
  IRelay,
} from "../../typechain"

import {
  RedemptionTestData,
  SinglePendingRequestedRedemption,
  MultiplePendingRequestedRedemptions,
  MultiplePendingRequestedRedemptionsWithP2WPKHChange,
} from "../data/redemption"

import {
  MultipleDepositsNoMainUtxo,
  MultipleDepositsWithMainUtxo,
  NO_MAIN_UTXO,
  SingleP2SHDeposit,
  SingleP2WSHDeposit,
  DepositSweepTestData,
} from "../data/deposit-sweep"

import {
  walletPublicKey,
  walletPublicKeyHash,
  nonWitnessSignSingleInputTx,
  nonWitnessSignMultipleInputsTx,
  witnessSignSingleInputTx,
  witnessSignMultipleInputTx,
} from "../data/fraud"

import {
  MovingFundsTestData,
  MultipleTargetWalletsAndDivisibleAmount,
  MultipleTargetWalletsAndIndivisibleAmount,
  SingleTargetWallet,
} from "../data/moving-funds"

import bridgeFixture from "../fixtures/bridge"
import { constants, walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { provider } = waffle
const { impersonateAccount } = helpers.account

const { lastBlockTime, increaseTime } = helpers.time

describe("Maintainer", () => {
  const activeWalletMainUtxo = {
    txHash:
      "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
    txOutputIndex: 1,
    txOutputValue: constants.walletCreationMinBtcBalance,
  }

  let governance: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let thirdParty: SignerWithAddress
  let deployer: SignerWithAddress

  let maintainerProxy: MaintainerProxy
  let reimbursementPool: ReimbursementPool
  let relay: FakeContract<IRelay>
  let walletRegistry: FakeContract<IWalletRegistry>

  let bank: Bank & BankStub
  let thirdPartyContract: SignerWithAddress

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      thirdParty,
      governance,
      bridge,
      maintainerProxy,
      relay,
      bank,
      reimbursementPool,
      maintainerProxy,
      deployer,
      thirdPartyContract,
    } = await waffle.loadFixture(bridgeFixture))

    walletRegistry = await smock.fake<IWalletRegistry>("IWalletRegistry", {
      address: (await bridge.contractReferences()).ecdsaWalletRegistry,
    })

    await deployer.sendTransaction({
      to: walletRegistry.address,
      value: ethers.utils.parseEther("100"),
    })
  })

  describe("requestNewWallet", () => {
    context("when called by an unauthorized third party", async () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy.connect(thirdParty).requestNewWallet(NO_MAIN_UTXO)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when called by an authorized third party", async () => {
      let tx: ContractTransaction
      let initThirdPartyBalance: BigNumber

      before(async () => {
        await createSnapshot()

        initThirdPartyBalance = await provider.getBalance(thirdParty.address)

        await maintainerProxy.connect(governance).authorize(thirdParty.address)
        await reimbursementPool
          .connect(governance)
          .authorize(maintainerProxy.address)

        tx = await maintainerProxy
          .connect(thirdParty)
          .requestNewWallet(activeWalletMainUtxo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit NewWalletRequested event", async () => {
        await expect(tx).to.emit(bridge, "NewWalletRequested")
      })

      it("should refund ETH", async () => {
        const postNotifyThirdPartyBalance = await provider.getBalance(
          thirdParty.address
        )
        const diff = postNotifyThirdPartyBalance.sub(initThirdPartyBalance)

        expect(diff).to.be.gt(0)
        expect(diff).to.be.lt(
          ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
        )
      })
    })
  })

  describe("submitDepositSweepProof", () => {
    context("when called by an unauthorized third party", async () => {
      const data: DepositSweepTestData = SingleP2SHDeposit
      // Take wallet public key hash from first deposit. All
      // deposits in same sweep batch should have the same value
      // of that field.
      const { walletPubKeyHash } = data.deposits[0].reveal

      before(async () => {
        await createSnapshot()

        await bridge.setWallet(walletPubKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
        // the initial value in the Bridge in order to save test Bitcoins.
        await bridge.setDepositDustThreshold(10000)

        const sweepOutcome: Promise<SweepScenarioOutcome> =
          runSweepScenario(data)

        await expect(sweepOutcome).to.be.revertedWith(
          "Caller is not authorized"
        )
      })
    })

    context("when called by an authorized party", async () => {
      before(async () => {
        await createSnapshot()

        await maintainerProxy.connect(governance).authorize(thirdParty.address)
        await reimbursementPool
          .connect(governance)
          .authorize(maintainerProxy.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the wallet state is Live", () => {
        context("when transaction proof is valid", () => {
          context("when there is only one output", () => {
            context("when wallet public key hash length is 20 bytes", () => {
              context("when main UTXO data are valid", () => {
                context(
                  "when transaction fee does not exceed the deposit transaction maximum fee",
                  () => {
                    context("when there is only one input", () => {
                      context(
                        "when the single input is a revealed unswept P2SH deposit",
                        () => {
                          const data: DepositSweepTestData = SingleP2SHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal
                          let sweepOutcome: SweepScenarioOutcome

                          before(async () => {
                            await createSnapshot()

                            // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
                            // the initial value in the Bridge in order to save test Bitcoins.
                            await bridge.setDepositDustThreshold(10000)

                            // Simulate the wallet is an Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ecdsaWalletID: ethers.constants.HashZero,
                              mainUtxoHash: ethers.constants.HashZero,
                              pendingRedemptionsValue: 0,
                              createdAt: await lastBlockTime(),
                              movingFundsRequestedAt: 0,
                              closingStartedAt: 0,
                              pendingMovedFundsSweepRequestsCount: 0,
                              state: walletState.Live,
                              movingFundsTargetWalletsCommitmentHash:
                                ethers.constants.HashZero,
                            })

                            sweepOutcome = await runSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should not revert", async () => {
                            await expect(sweepOutcome.tx.wait()).not.to.be
                              .reverted
                          })

                          it("should refund ETH", async () => {
                            const postNotifyThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)
                            const diff = postNotifyThirdPartyBalance.sub(
                              sweepOutcome.initThirdPartyBalance
                            )

                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("1500000", "gwei") // 0,0015 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when the single input is a revealed unswept P2WSH deposit",
                        () => {
                          const data: DepositSweepTestData = SingleP2WSHDeposit
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal
                          let sweepOutcome: SweepScenarioOutcome

                          before(async () => {
                            await createSnapshot()

                            // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
                            // the initial value in the Bridge in order to save test Bitcoins.
                            await bridge.setDepositDustThreshold(10000)

                            // Simulate the wallet is an Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ecdsaWalletID: ethers.constants.HashZero,
                              mainUtxoHash: ethers.constants.HashZero,
                              pendingRedemptionsValue: 0,
                              createdAt: await lastBlockTime(),
                              movingFundsRequestedAt: 0,
                              closingStartedAt: 0,
                              pendingMovedFundsSweepRequestsCount: 0,
                              state: walletState.Live,
                              movingFundsTargetWalletsCommitmentHash:
                                ethers.constants.HashZero,
                            })

                            sweepOutcome = await runSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should not revert", async () => {
                            await expect(sweepOutcome.tx.wait()).not.to.be
                              .reverted
                          })

                          it("should refund ETH", async () => {
                            const postNotifyThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)
                            const diff = postNotifyThirdPartyBalance.sub(
                              sweepOutcome.initThirdPartyBalance
                            )

                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                            )
                          })
                        }
                      )
                    })

                    context("when there are multiple inputs", () => {
                      context(
                        "when input vector consists only of revealed unswept " +
                          "deposits and the expected main UTXO",
                        () => {
                          const previousData: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          const data: DepositSweepTestData =
                            MultipleDepositsWithMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal
                          let sweepOutcome: SweepScenarioOutcome

                          before(async () => {
                            await createSnapshot()

                            // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
                            // the initial value in the Bridge in order to save test Bitcoins.
                            await bridge.setDepositDustThreshold(10000)

                            // Simulate the wallet is an Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ecdsaWalletID: ethers.constants.HashZero,
                              mainUtxoHash: ethers.constants.HashZero,
                              pendingRedemptionsValue: 0,
                              createdAt: await lastBlockTime(),
                              movingFundsRequestedAt: 0,
                              closingStartedAt: 0,
                              pendingMovedFundsSweepRequestsCount: 0,
                              state: walletState.Live,
                              movingFundsTargetWalletsCommitmentHash:
                                ethers.constants.HashZero,
                            })

                            // Make the first sweep which is actually the predecessor
                            // of the sweep tested within this scenario.
                            await runSweepScenario(previousData)

                            sweepOutcome = await runSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should not revert", async () => {
                            await expect(sweepOutcome.tx.wait()).not.to.be
                              .reverted
                          })

                          it("should refund ETH", async () => {
                            const postNotifyThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)
                            const diff = postNotifyThirdPartyBalance.sub(
                              sweepOutcome.initThirdPartyBalance
                            )

                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when input vector consists only of revealed unswept " +
                          "deposits but there is no main UTXO since it is not expected",
                        () => {
                          const data: DepositSweepTestData =
                            MultipleDepositsNoMainUtxo
                          // Take wallet public key hash from first deposit. All
                          // deposits in same sweep batch should have the same value
                          // of that field.
                          const { walletPubKeyHash } = data.deposits[0].reveal
                          let sweepOutcome: SweepScenarioOutcome

                          before(async () => {
                            await createSnapshot()

                            // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
                            // the initial value in the Bridge in order to save test Bitcoins.
                            await bridge.setDepositDustThreshold(10000)

                            // Simulate the wallet is an Live one and is known in
                            // the system.
                            await bridge.setWallet(walletPubKeyHash, {
                              ecdsaWalletID: ethers.constants.HashZero,
                              mainUtxoHash: ethers.constants.HashZero,
                              pendingRedemptionsValue: 0,
                              createdAt: await lastBlockTime(),
                              movingFundsRequestedAt: 0,
                              closingStartedAt: 0,
                              pendingMovedFundsSweepRequestsCount: 0,
                              state: walletState.Live,
                              movingFundsTargetWalletsCommitmentHash:
                                ethers.constants.HashZero,
                            })

                            sweepOutcome = await runSweepScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should not revert", async () => {
                            await expect(sweepOutcome.tx.wait()).not.to.be
                              .reverted
                          })

                          it("should refund ETH", async () => {
                            const postNotifyThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)
                            const diff = postNotifyThirdPartyBalance.sub(
                              sweepOutcome.initThirdPartyBalance
                            )

                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
                            )
                          })
                        }
                      )
                    })
                  }
                )
              })
            })
          })
        })
      })
    })

    context("when the wallet state is MovingFunds", () => {
      // The execution of `submitDepositSweepProof` is the same for wallets in
      // `MovingFunds` state as for the ones in `Live` state. Therefore the
      // testing of `MovingFunds` state is limited to just one simple test case
      // (sweeping single P2SH deposit).
      const data: DepositSweepTestData = SingleP2SHDeposit
      const { fundingTx, reveal } = data.deposits[0]

      let tx: Promise<ContractTransaction>
      let initThirdPartyBalance: BigNumber

      before(async () => {
        await createSnapshot()

        // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
        // the initial value in the Bridge in order to save test Bitcoins.
        await bridge.setDepositDustThreshold(10000)

        // Initially set the state to Live, so that the deposit can be revealed
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ecdsaWalletID: ethers.constants.HashZero,
          mainUtxoHash: ethers.constants.HashZero,
          pendingRedemptionsValue: 0,
          createdAt: await lastBlockTime(),
          movingFundsRequestedAt: 0,
          closingStartedAt: 0,
          pendingMovedFundsSweepRequestsCount: 0,
          state: walletState.Live,
          movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
        })

        relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
        relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

        await bridge.revealDeposit(fundingTx, reveal)

        // Simulate the wallet's state has changed to MovingFunds
        const wallet = await bridge.wallets(reveal.walletPubKeyHash)
        await bridge.setWallet(reveal.walletPubKeyHash, {
          ...wallet,
          state: walletState.MovingFunds,
        })

        initThirdPartyBalance = await provider.getBalance(thirdParty.address)

        await maintainerProxy.connect(governance).authorize(thirdParty.address)
        await reimbursementPool
          .connect(governance)
          .authorize(maintainerProxy.address)

        tx = maintainerProxy
          .connect(thirdParty)
          .submitDepositSweepProof(data.sweepTx, data.sweepProof, data.mainUtxo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should successfully submit sweep proof", async () => {
        await expect(tx).not.to.be.reverted
      })

      it("should refund ETH", async () => {
        const postNotifyThirdPartyBalance = await provider.getBalance(
          thirdParty.address
        )
        const diff = postNotifyThirdPartyBalance.sub(initThirdPartyBalance)

        expect(diff).to.be.gt(0)
        expect(diff).to.be.lt(
          ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
        )
      })
    })
  })

  describe("submitRedemptionProof", () => {
    let redemptionTimeout: BigNumber

    context("when called by an unauthorized third party", async () => {
      before(async () => {
        await createSnapshot()
        ;({ redemptionTimeout } = await bridge.redemptionParameters())
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        // Simulate the situation when treasury fee is 0% to
        // allow using the whole wallet's main UTXO value
        // to fulfill the redemption request.
        await bridge.setRedemptionTreasuryFeeDivisor(0)
        const data: RedemptionTestData = SinglePendingRequestedRedemption
        await expect(runRedemptionScenario(data)).to.be.revertedWith(
          "Caller is not authorized"
        )
      })
    })

    context("when called by an authorized party", async () => {
      context("when transaction proof is valid", () => {
        before(async () => {
          await createSnapshot()

          await maintainerProxy
            .connect(governance)
            .authorize(thirdParty.address)
          await reimbursementPool
            .connect(governance)
            .authorize(maintainerProxy.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when there is a main UTXO for the given wallet", () => {
          context("when main UTXO data are valid", () => {
            context("when there is only one input", () => {
              context(
                "when the single input points to the wallet's main UTXO",
                () => {
                  context("when wallet state is Live", () => {
                    context("when there is only one output", () => {
                      context(
                        "when the single output is a pending requested redemption",
                        () => {
                          const data: RedemptionTestData =
                            SinglePendingRequestedRedemption

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption request.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("3500000", "gwei") // 0,0035 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when the single output is a non-reported timed out requested redemption",
                        () => {
                          const data: RedemptionTestData =
                            SinglePendingRequestedRedemption

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption request.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the request
                            // timed out though don't report the timeout.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("3500000", "gwei") // 0,0035 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when the single output is a reported timed out requested redemption",
                        () => {
                          const data: RedemptionTestData =
                            SinglePendingRequestedRedemption

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption request.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the request
                            // timed out and then report the timeout.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)
                              await bridge.notifyRedemptionTimeout(
                                data.wallet.pubKeyHash,
                                [],
                                data.redemptionRequests[0].redeemerOutputScript
                              )
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )

                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                            )
                          })
                        }
                      )
                    })

                    context("when there are multiple outputs", () => {
                      context(
                        "when output vector consists only of pending requested redemptions",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptions

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption requests.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("8000000", "gwei") // 0,008 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when output vector consists of pending requested redemptions and a non-zero change",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptionsWithP2WPKHChange

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(data)
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("9000000", "gwei") // 0,009 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when output vector consists only of reported timed out requested redemptions",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptions

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption requests.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the requests
                            // timed out and then report the timeouts.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)

                              for (
                                let i = 0;
                                i < data.redemptionRequests.length;
                                i++
                              ) {
                                // eslint-disable-next-line no-await-in-loop
                                await bridge.notifyRedemptionTimeout(
                                  data.wallet.pubKeyHash,
                                  [],
                                  data.redemptionRequests[i]
                                    .redeemerOutputScript
                                )
                              }
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(
                              ethers.utils.parseUnits("-1000000", "gwei")
                            ) // // -0,001 ETH
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("1000000", "gwei") // 0,001 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when output vector consists of reported timed out requested redemptions and a non-zero change",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptionsWithP2WPKHChange

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the requests
                            // timed out and then report the timeouts.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)

                              for (
                                let i = 0;
                                i < data.redemptionRequests.length;
                                i++
                              ) {
                                // eslint-disable-next-line no-await-in-loop
                                await bridge.notifyRedemptionTimeout(
                                  data.wallet.pubKeyHash,
                                  [],
                                  data.redemptionRequests[i]
                                    .redeemerOutputScript
                                )
                              }
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(
                              ethers.utils.parseUnits("-2000000", "gwei")
                            ) // -0,002 ETH
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when output vector consists of pending requested redemptions and reported timed out requested redemptions",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptions

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Simulate the situation when treasury fee is 0% to
                            // allow using the whole wallet's main UTXO value
                            // to fulfill the redemption requests.
                            await bridge.setRedemptionTreasuryFeeDivisor(0)

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the requests
                            // timed out but report timeout only the two first
                            // requests.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)

                              await bridge.notifyRedemptionTimeout(
                                data.wallet.pubKeyHash,
                                [],
                                data.redemptionRequests[0].redeemerOutputScript
                              )
                              await bridge.notifyRedemptionTimeout(
                                data.wallet.pubKeyHash,
                                [],
                                data.redemptionRequests[1].redeemerOutputScript
                              )
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("6000000", "gwei") // 0,006 ETH
                            )
                          })
                        }
                      )

                      context(
                        "when output vector consists of pending requested redemptions, reported timed out requested redemptions and a non-zero change",
                        () => {
                          const data: RedemptionTestData =
                            MultiplePendingRequestedRedemptionsWithP2WPKHChange

                          let outcome: Promise<RedemptionScenarioOutcome>

                          before(async () => {
                            await createSnapshot()

                            // Before submitting the redemption proof, wait
                            // an amount of time that will make the requests
                            // timed out but report timeout only the two first
                            // requests.
                            const beforeProofActions = async () => {
                              await increaseTime(redemptionTimeout)

                              await bridge.notifyRedemptionTimeout(
                                data.wallet.pubKeyHash,
                                [],
                                data.redemptionRequests[0].redeemerOutputScript
                              )
                              await bridge.notifyRedemptionTimeout(
                                data.wallet.pubKeyHash,
                                [],
                                data.redemptionRequests[1].redeemerOutputScript
                              )
                            }

                            // eslint-disable-next-line @typescript-eslint/no-extra-semi
                            outcome = runRedemptionScenario(
                              data,
                              beforeProofActions
                            )
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          it("should succeed", async () => {
                            await expect(outcome).to.not.be.reverted
                          })

                          it("should refund ETH", async () => {
                            const resolvedOutcome = await outcome

                            const postThirdPartyBalance =
                              await provider.getBalance(thirdParty.address)

                            const diff = postThirdPartyBalance.sub(
                              resolvedOutcome.initThirdPartyBalance
                            )
                            expect(diff).to.be.gt(0)
                            expect(diff).to.be.lt(
                              ethers.utils.parseUnits("5500000", "gwei") // 0,0055 ETH
                            )
                          })
                        }
                      )
                    })
                  })

                  context("when wallet state is MovingFunds", () => {
                    const data: RedemptionTestData =
                      MultiplePendingRequestedRedemptionsWithP2WPKHChange

                    let outcome: Promise<RedemptionScenarioOutcome>

                    before(async () => {
                      await createSnapshot()

                      // Set wallet state to MovingFunds. That must be done
                      // just before proof submission since requests should
                      // be made against a Live wallet.
                      const beforeProofActions = async () => {
                        const wallet = await bridge.wallets(
                          data.wallet.pubKeyHash
                        )
                        await bridge.setWallet(data.wallet.pubKeyHash, {
                          ...wallet,
                          state: walletState.MovingFunds,
                        })
                      }

                      outcome = runRedemptionScenario(data, beforeProofActions)
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    // Just assert it passes without revert without repeating
                    // checks from Live state scenario.
                    it("should succeed", async () => {
                      await expect(outcome).to.not.be.reverted
                    })

                    it("should refund ETH", async () => {
                      const resolvedOutcome = await outcome

                      const postThirdPartyBalance = await provider.getBalance(
                        thirdParty.address
                      )

                      const diff = postThirdPartyBalance.sub(
                        resolvedOutcome.initThirdPartyBalance
                      )
                      expect(diff).to.be.gt(0)
                      expect(diff).to.be.lt(
                        ethers.utils.parseUnits("9000000", "gwei") // 0,009 ETH
                      )
                    })
                  })
                }
              )
            })
          })
        })
      })
    })
  })

  describe("notifyCloseableWallet", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      walletRegistry.requestNewWallet.reset()

      await restoreSnapshot()
    })
    context("when called by an unauthorized third party", async () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .notifyCloseableWallet(
              ecdsaWalletTestData.pubKeyHash160,
              NO_MAIN_UTXO
            )
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when called by an authorized party", async () => {
      context("when the reported wallet is not the active one", () => {
        context("when wallet is in Live state", () => {
          before(async () => {
            await createSnapshot()

            await maintainerProxy
              .connect(governance)
              .authorize(walletRegistry.address)
            await reimbursementPool
              .connect(governance)
              .authorize(maintainerProxy.address)

            // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
            // the initial value in the Bridge in order to save test Bitcoins.
            await bridge.setDepositDustThreshold(10000)

            await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
              ecdsaWalletID: ecdsaWalletTestData.walletID,
              mainUtxoHash: ethers.constants.HashZero,
              pendingRedemptionsValue: 0,
              createdAt: await lastBlockTime(),
              movingFundsRequestedAt: 0,
              closingStartedAt: 0,
              pendingMovedFundsSweepRequestsCount: 0,
              state: walletState.Live,
              movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
            })
          })

          after(async () => {
            walletRegistry.requestNewWallet.reset()

            await restoreSnapshot()
          })

          context("when wallet reached the maximum age", () => {
            before(async () => {
              await createSnapshot()

              await increaseTime((await bridge.walletParameters()).walletMaxAge)
            })

            after(async () => {
              walletRegistry.requestNewWallet.reset()

              await restoreSnapshot()
            })

            context("when wallet balance is zero", () => {
              let tx: ContractTransaction
              let initWalletRegistryBalance: BigNumber

              before(async () => {
                await createSnapshot()

                initWalletRegistryBalance = await provider.getBalance(
                  await walletRegistry.wallet.getAddress()
                )

                tx = await maintainerProxy
                  .connect(walletRegistry.wallet)
                  .notifyCloseableWallet(
                    ecdsaWalletTestData.pubKeyHash160,
                    NO_MAIN_UTXO
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should not revert", async () => {
                await expect(tx.wait()).not.to.be.reverted
              })

              it("should refund ETH", async () => {
                const postWalletRegistryBalance = await provider.getBalance(
                  walletRegistry.wallet.getAddress()
                )
                const diff = postWalletRegistryBalance.sub(
                  initWalletRegistryBalance
                )

                expect(diff).to.be.gt(0)
                expect(diff).to.be.lt(
                  ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                )
              })
            })

            context("when wallet balance is greater than zero", () => {
              const walletMainUtxo = {
                txHash:
                  "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                txOutputIndex: 0,
                txOutputValue: 1,
              }

              let tx: ContractTransaction
              let initWalletRegistryBalance: BigNumber

              before(async () => {
                await createSnapshot()

                await bridge.setWalletMainUtxo(
                  ecdsaWalletTestData.pubKeyHash160,
                  walletMainUtxo
                )

                initWalletRegistryBalance = await provider.getBalance(
                  walletRegistry.wallet.getAddress()
                )
                tx = await maintainerProxy
                  .connect(walletRegistry.wallet)
                  .notifyCloseableWallet(
                    ecdsaWalletTestData.pubKeyHash160,
                    walletMainUtxo
                  )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should not revert", async () => {
                await expect(tx.wait()).not.to.be.reverted
              })

              it("should refund ETH", async () => {
                const postWalletRegistryBalance = await provider.getBalance(
                  walletRegistry.wallet.getAddress()
                )
                const diff = postWalletRegistryBalance.sub(
                  initWalletRegistryBalance
                )

                expect(diff).to.be.gt(0)
                expect(diff).to.be.lt(
                  ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                )
              })
            })
          })

          context(
            "when wallet did not reach the maximum age but their balance is lesser than the minimum threshold",
            () => {
              context("when wallet balance is zero", () => {
                let tx: Promise<ContractTransaction>
                let initWalletRegistryBalance: BigNumber

                before(async () => {
                  await createSnapshot()

                  initWalletRegistryBalance = await provider.getBalance(
                    walletRegistry.wallet.getAddress()
                  )
                  tx = maintainerProxy
                    .connect(walletRegistry.wallet)
                    .notifyCloseableWallet(
                      ecdsaWalletTestData.pubKeyHash160,
                      NO_MAIN_UTXO
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should not revert", async () => {
                  await expect(tx).not.to.be.reverted
                })

                it("should refund ETH", async () => {
                  const postWalletRegistryBalance = await provider.getBalance(
                    walletRegistry.wallet.getAddress()
                  )
                  const diff = postWalletRegistryBalance.sub(
                    initWalletRegistryBalance
                  )

                  expect(diff).to.be.gt(0)
                  expect(diff).to.be.lt(
                    ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                  )
                })
              })

              context("when wallet balance is greater than zero", () => {
                const walletMainUtxo = {
                  txHash:
                    "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                  txOutputIndex: 0,
                  txOutputValue: constants.walletClosureMinBtcBalance.sub(1),
                }

                let tx: ContractTransaction
                let initWalletRegistryBalance: BigNumber

                before(async () => {
                  await createSnapshot()

                  await bridge.setWalletMainUtxo(
                    ecdsaWalletTestData.pubKeyHash160,
                    walletMainUtxo
                  )

                  initWalletRegistryBalance = await provider.getBalance(
                    walletRegistry.wallet.getAddress()
                  )
                  tx = await maintainerProxy
                    .connect(walletRegistry.wallet)
                    .notifyCloseableWallet(
                      ecdsaWalletTestData.pubKeyHash160,
                      walletMainUtxo
                    )
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should not revert", async () => {
                  await expect(tx.wait()).not.to.be.reverted
                })

                it("should refund ETH", async () => {
                  const postWalletRegistryBalance = await provider.getBalance(
                    walletRegistry.wallet.getAddress()
                  )
                  const diff = postWalletRegistryBalance.sub(
                    initWalletRegistryBalance
                  )

                  expect(diff).to.be.gt(0)
                  expect(diff).to.be.lt(
                    ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                  )
                })
              })
            }
          )
        })
      })
    })
  })

  describe("defeatFraudChallenge", () => {
    let fraudChallengeDepositAmount: BigNumber

    before(async () => {
      await createSnapshot()
      ;({ fraudChallengeDepositAmount } = await bridge.fraudParameters())
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by an unauthorized third party", async () => {
      const data = nonWitnessSignSingleInputTx

      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .defeatFraudChallenge(walletPublicKey, data.preimage, data.witness)
        ).to.be.revertedWith("Caller is not authorized")
      })
    })

    context("when called by an authorized party", async () => {
      before(async () => {
        await createSnapshot()

        await maintainerProxy.connect(governance).authorize(thirdParty.address)
        await reimbursementPool
          .connect(governance)
          .authorize(maintainerProxy.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the challenge exists", () => {
        context("when the challenge is open", () => {
          context("when the sighash type is correct", () => {
            context("when the input is non-witness", () => {
              context("when the transaction has single input", () => {
                context(
                  "when the input is marked as correctly spent in the Bridge",
                  () => {
                    const data = nonWitnessSignSingleInputTx
                    let tx: Promise<ContractTransaction>
                    let initThirdPartyBalance: BigNumber

                    before(async () => {
                      await createSnapshot()

                      await bridge.setWallet(walletPublicKeyHash, {
                        ecdsaWalletID: ethers.constants.HashZero,
                        mainUtxoHash: ethers.constants.HashZero,
                        pendingRedemptionsValue: 0,
                        createdAt: await lastBlockTime(),
                        movingFundsRequestedAt: 0,
                        closingStartedAt: 0,
                        pendingMovedFundsSweepRequestsCount: 0,
                        state: walletState.Live,
                        movingFundsTargetWalletsCommitmentHash:
                          ethers.constants.HashZero,
                      })
                      await bridge.setSweptDeposits(data.deposits)
                      await bridge.setSpentMainUtxos(data.spentMainUtxos)
                      await bridge.setProcessedMovedFundsSweepRequests(
                        data.movedFundsSweepRequests
                      )

                      await bridge
                        .connect(thirdParty)
                        .submitFraudChallenge(
                          walletPublicKey,
                          data.sighash,
                          data.signature,
                          {
                            value: fraudChallengeDepositAmount,
                          }
                        )

                      initThirdPartyBalance = await provider.getBalance(
                        thirdParty.address
                      )

                      tx = maintainerProxy
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should not revert 1", async () => {
                      await expect(tx).not.to.be.reverted
                    })

                    it("should refund ETH 1", async () => {
                      const postWalletRegistryBalance =
                        await provider.getBalance(thirdParty.address)
                      const diff = postWalletRegistryBalance.sub(
                        initThirdPartyBalance
                      )

                      expect(diff).to.be.gt(0)
                      expect(diff).to.be.lt(
                        ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                      )
                    })
                  }
                )
              })

              context("when the transaction has multiple inputs", () => {
                context(
                  "when the input is marked as correctly spent in the Bridge",
                  () => {
                    const data = nonWitnessSignMultipleInputsTx
                    let tx: Promise<ContractTransaction>
                    let initThirdPartyBalance: BigNumber

                    before(async () => {
                      await createSnapshot()

                      await bridge.setWallet(walletPublicKeyHash, {
                        ecdsaWalletID: ethers.constants.HashZero,
                        mainUtxoHash: ethers.constants.HashZero,
                        pendingRedemptionsValue: 0,
                        createdAt: await lastBlockTime(),
                        movingFundsRequestedAt: 0,
                        closingStartedAt: 0,
                        pendingMovedFundsSweepRequestsCount: 0,
                        state: walletState.Live,
                        movingFundsTargetWalletsCommitmentHash:
                          ethers.constants.HashZero,
                      })
                      await bridge.setSweptDeposits(data.deposits)
                      await bridge.setSpentMainUtxos(data.spentMainUtxos)

                      await bridge
                        .connect(thirdParty)
                        .submitFraudChallenge(
                          walletPublicKey,
                          data.sighash,
                          data.signature,
                          {
                            value: fraudChallengeDepositAmount,
                          }
                        )

                      initThirdPartyBalance = await provider.getBalance(
                        thirdParty.address
                      )

                      tx = maintainerProxy
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should not revert", async () => {
                      await expect(tx).not.to.be.reverted
                    })

                    it("should refund ETH", async () => {
                      const postWalletRegistryBalance =
                        await provider.getBalance(thirdParty.address)
                      const diff = postWalletRegistryBalance.sub(
                        initThirdPartyBalance
                      )

                      expect(diff).to.be.gt(0)
                      expect(diff).to.be.lt(
                        ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                      )
                    })
                  }
                )
              })
            })

            context("when the input is witness", () => {
              context("when the transaction has single input", () => {
                context(
                  "when the input is marked as correctly spent in the Bridge",
                  () => {
                    const data = witnessSignSingleInputTx
                    let tx: Promise<ContractTransaction>
                    let initThirdPartyBalance: BigNumber

                    before(async () => {
                      await createSnapshot()

                      await bridge.setWallet(walletPublicKeyHash, {
                        ecdsaWalletID: ethers.constants.HashZero,
                        mainUtxoHash: ethers.constants.HashZero,
                        pendingRedemptionsValue: 0,
                        createdAt: await lastBlockTime(),
                        movingFundsRequestedAt: 0,
                        closingStartedAt: 0,
                        pendingMovedFundsSweepRequestsCount: 0,
                        state: walletState.Live,
                        movingFundsTargetWalletsCommitmentHash:
                          ethers.constants.HashZero,
                      })
                      await bridge.setSweptDeposits(data.deposits)
                      await bridge.setSpentMainUtxos(data.spentMainUtxos)

                      await bridge
                        .connect(thirdParty)
                        .submitFraudChallenge(
                          walletPublicKey,
                          data.sighash,
                          data.signature,
                          {
                            value: fraudChallengeDepositAmount,
                          }
                        )

                      initThirdPartyBalance = await provider.getBalance(
                        thirdParty.address
                      )

                      tx = maintainerProxy
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should not revert", async () => {
                      await expect(tx).not.to.be.reverted
                    })

                    it("should refund ETH", async () => {
                      const postWalletRegistryBalance =
                        await provider.getBalance(thirdParty.address)
                      const diff = postWalletRegistryBalance.sub(
                        initThirdPartyBalance
                      )

                      expect(diff).to.be.gt(0)
                      expect(diff).to.be.lt(
                        ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                      )
                    })
                  }
                )
              })

              context("when the transaction has multiple inputs", () => {
                context(
                  "when the input is marked as correctly spent in the Bridge",
                  () => {
                    const data = witnessSignMultipleInputTx
                    let tx: Promise<ContractTransaction>
                    let initThirdPartyBalance: BigNumber

                    before(async () => {
                      await createSnapshot()

                      await bridge.setWallet(walletPublicKeyHash, {
                        ecdsaWalletID: ethers.constants.HashZero,
                        mainUtxoHash: ethers.constants.HashZero,
                        pendingRedemptionsValue: 0,
                        createdAt: await lastBlockTime(),
                        movingFundsRequestedAt: 0,
                        closingStartedAt: 0,
                        pendingMovedFundsSweepRequestsCount: 0,
                        state: walletState.Live,
                        movingFundsTargetWalletsCommitmentHash:
                          ethers.constants.HashZero,
                      })
                      await bridge.setSweptDeposits(data.deposits)
                      await bridge.setSpentMainUtxos(data.spentMainUtxos)

                      await bridge
                        .connect(thirdParty)
                        .submitFraudChallenge(
                          walletPublicKey,
                          data.sighash,
                          data.signature,
                          {
                            value: fraudChallengeDepositAmount,
                          }
                        )

                      initThirdPartyBalance = await provider.getBalance(
                        thirdParty.address
                      )

                      tx = maintainerProxy
                        .connect(thirdParty)
                        .defeatFraudChallenge(
                          walletPublicKey,
                          data.preimage,
                          data.witness
                        )
                    })

                    after(async () => {
                      await restoreSnapshot()
                    })

                    it("should not revert", async () => {
                      await expect(tx).not.to.be.reverted
                    })

                    it("should refund ETH", async () => {
                      const postWalletRegistryBalance =
                        await provider.getBalance(thirdParty.address)
                      const diff = postWalletRegistryBalance.sub(
                        initThirdPartyBalance
                      )

                      expect(diff).to.be.gt(0)
                      expect(diff).to.be.lt(
                        ethers.utils.parseUnits("2000000", "gwei") // 0,002 ETH
                      )
                    })
                  }
                )
              })
            })
          })
        })
      })
    })
  })

  describe("submitMovingFundsProof", () => {
    context("when transaction proof is valid", () => {
      context("when there is a main UTXO for the given wallet", () => {
        context("when main UTXO data are valid", () => {
          context("when there is only one input", () => {
            context(
              "when the single input points to the wallet's main UTXO",
              () => {
                context(
                  "when the output vector references only 20-byte hashes",
                  () => {
                    context(
                      "when the output vector has only P2PKH and P2WPKH outputs",
                      () => {
                        context(
                          "when transaction amount is distributed evenly",
                          () => {
                            context(
                              "when transaction fee is not too high",
                              () => {
                                context(
                                  "when source wallet is in the MovingFunds state",
                                  () => {
                                    context(
                                      "when target wallets commitment is submitted",
                                      () => {
                                        context(
                                          "when actual target wallets correspond to the commitment",
                                          () => {
                                            before(async () => {
                                              await createSnapshot()

                                              await maintainerProxy
                                                .connect(governance)
                                                .authorize(thirdParty.address)
                                              await reimbursementPool
                                                .connect(governance)
                                                .authorize(
                                                  maintainerProxy.address
                                                )
                                            })

                                            after(async () => {
                                              walletRegistry.requestNewWallet.reset()

                                              await restoreSnapshot()
                                            })

                                            const testData: {
                                              testName: string
                                              data: MovingFundsTestData
                                            }[] = [
                                              {
                                                testName:
                                                  "when there is a single target wallet",
                                                data: SingleTargetWallet,
                                              },
                                              {
                                                testName:
                                                  "when there are multiple target wallets and the amount is indivisible",
                                                data: MultipleTargetWalletsAndIndivisibleAmount,
                                              },
                                              {
                                                testName:
                                                  "when there are multiple target wallets and the amount is divisible",
                                                data: MultipleTargetWalletsAndDivisibleAmount,
                                              },
                                            ]

                                            testData.forEach((test) => {
                                              context(test.testName, () => {
                                                let outcome: MovingFundsScenarioOutcome

                                                before(async () => {
                                                  await createSnapshot()

                                                  outcome =
                                                    await runMovingFundsScenario(
                                                      test.data
                                                    )
                                                })

                                                after(async () => {
                                                  await restoreSnapshot()
                                                })

                                                it("should succeed", async () => {
                                                  await expect(
                                                    outcome.tx.wait()
                                                  ).not.to.be.reverted
                                                })

                                                it("should refund ETH", async () => {
                                                  const postThirdPartyBalance =
                                                    await provider.getBalance(
                                                      thirdParty.address
                                                    )
                                                  const diff =
                                                    postThirdPartyBalance.sub(
                                                      outcome.initThirdPartyBalance
                                                    )

                                                  expect(diff).to.be.gt(0)
                                                  expect(diff).to.be.lt(
                                                    ethers.utils.parseUnits(
                                                      "2000000",
                                                      "gwei"
                                                    ) // 0,002 ETH
                                                  )
                                                })
                                              })
                                            })
                                          }
                                        )
                                      }
                                    )
                                  }
                                )
                              }
                            )
                          }
                        )
                      }
                    )
                  }
                )
              }
            )
          })
        })
      })
    })
  })

  describe("submitMovingFundsCommitment", () => {
    const walletDraft = {
      ecdsaWalletID: ecdsaWalletTestData.walletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 0,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Unknown,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    }

    context("when source wallet is in the MovingFunds state", () => {
      before(async () => {
        await createSnapshot()

        await bridge.setWallet(ecdsaWalletTestData.pubKeyHash160, {
          ...walletDraft,
          state: walletState.MovingFunds,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when source wallet has no pending redemptions", () => {
        // The wallet created using the `walletDraft` has no pending redemptions
        // by default. No need to do anything here.

        context(
          "when source wallet has no pending moved funds sweep requests",
          () => {
            // The wallet created using the `walletDraft` has no pending moved
            // funds sweep requests by default. No need to do anything here.

            context("when the commitment was not submitted yet", () => {
              // The wallet created using the `walletDraft` has no commitment
              // submitted by default. No need to do anything here.

              context(
                "when the caller is a member of the source wallet",
                () => {
                  const walletMembersIDs = [1, 2, 3, 4, 5]
                  const walletMemberIndex = 2

                  let caller: SignerWithAddress

                  before(async () => {
                    await createSnapshot()

                    caller = thirdParty

                    await maintainerProxy
                      .connect(governance)
                      .authorize(caller.address)
                    await reimbursementPool
                      .connect(governance)
                      .authorize(maintainerProxy.address)

                    walletRegistry.isWalletMember
                      .whenCalledWith(
                        ecdsaWalletTestData.walletID,
                        walletMembersIDs,
                        maintainerProxy.address,
                        walletMemberIndex
                      )
                      .returns(true)
                  })

                  after(async () => {
                    walletRegistry.isWalletMember.reset()

                    await restoreSnapshot()
                  })

                  context("when passed wallet main UTXO is valid", () => {
                    context("when wallet balance is greater than zero", () => {
                      // Just an arbitrary main UTXO with value of 26 BTC.
                      const mainUtxo = {
                        txHash:
                          "0xc9e58780c6c289c25ae1fe293f85a4db4d0af4f305172f2a1868ddd917458bdf",
                        txOutputIndex: 0,
                        txOutputValue: to1ePrecision(26, 8),
                      }

                      before(async () => {
                        await createSnapshot()

                        // Set up a main UTXO for the source wallet.
                        await bridge.setWalletMainUtxo(
                          ecdsaWalletTestData.pubKeyHash160,
                          mainUtxo
                        )
                      })

                      after(async () => {
                        await restoreSnapshot()
                      })

                      context(
                        "when the expected target wallets count is greater than zero",
                        () => {
                          // Just some arbitrary 20-byte hashes to simulate live
                          // wallets PKHs. They are ordered in the expected way, i.e.
                          // the hashes represented as numbers form a strictly
                          // increasing sequence.
                          const liveWallets = [
                            "0x4b440cb29c80c3f256212d8fdd4f2125366f3c91",
                            "0x888f01315e0268bfa05d5e522f8d63f6824d9a96",
                            "0xb2a89e53a4227dbe530a52a1c419040735fa636c",
                            "0xbf198e8fff0f90af01024153701da99b9bc08dc5",
                            "0xffb9e05013f5cd126915bc03d340cc5c1be81862",
                          ]

                          before(async () => {
                            await createSnapshot()

                            for (let i = 0; i < liveWallets.length; i++) {
                              // eslint-disable-next-line no-await-in-loop
                              await bridge.setWallet(liveWallets[i], {
                                ...walletDraft,
                                state: walletState.Live,
                              })
                            }
                          })

                          after(async () => {
                            await restoreSnapshot()
                          })

                          context(
                            "when the submitted target wallets count is same as the expected",
                            () => {
                              const expectedTargetWalletsCount = 3

                              context(
                                "when all target wallets are different than the source wallet",
                                () => {
                                  context(
                                    "when all target wallets follow the expected order",
                                    () => {
                                      context(
                                        "when all target wallets are in the Live state",
                                        () => {
                                          let tx: ContractTransaction
                                          let initCallerBalance: BigNumber

                                          const targetWallets =
                                            liveWallets.slice(
                                              0,
                                              expectedTargetWalletsCount
                                            )

                                          before(async () => {
                                            await createSnapshot()

                                            initCallerBalance =
                                              await provider.getBalance(
                                                caller.address
                                              )

                                            tx = await maintainerProxy
                                              .connect(caller)
                                              .submitMovingFundsCommitment(
                                                ecdsaWalletTestData.pubKeyHash160,
                                                mainUtxo,
                                                walletMembersIDs,
                                                walletMemberIndex,
                                                targetWallets
                                              )
                                          })

                                          after(async () => {
                                            await restoreSnapshot()
                                          })

                                          it("should not revert", async () => {
                                            await expect(tx.wait()).not.to.be
                                              .reverted
                                          })

                                          it("should refund ETH", async () => {
                                            const postThirdPartyBalance =
                                              await provider.getBalance(
                                                caller.address
                                              )
                                            const diff =
                                              postThirdPartyBalance.sub(
                                                initCallerBalance
                                              )

                                            expect(diff).to.be.gt(0)
                                            expect(diff).to.be.lt(
                                              ethers.utils.parseUnits(
                                                "1000000",
                                                "gwei"
                                              ) // 0,001 ETH
                                            )
                                          })
                                        }
                                      )
                                    }
                                  )
                                }
                              )
                            }
                          )
                        }
                      )
                    })
                  })
                }
              )
            })
          }
        )
      })
    })
  })

  describe("authorize", () => {
    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .authorize(thirdPartyContract.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      it("should authorize a contract", async () => {
        const tx = await maintainerProxy
          .connect(governance)
          .authorize(thirdPartyContract.address)

        await expect(
          await maintainerProxy.isAuthorized(thirdPartyContract.address)
        ).to.be.true

        await expect(tx)
          .to.emit(maintainerProxy, "MaintainerAuthorized")
          .withArgs(thirdPartyContract.address)
      })
    })
  })

  describe("unauthorize", () => {
    beforeEach(async () => {
      await createSnapshot()

      await maintainerProxy
        .connect(governance)
        .authorize(thirdPartyContract.address)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    context("when the caller is not the owner", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .unauthorize(thirdPartyContract.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when the caller is the owner", () => {
      it("should unauthorize a contract", async () => {
        const tx = await maintainerProxy
          .connect(governance)
          .unauthorize(thirdPartyContract.address)

        await expect(
          await maintainerProxy.isAuthorized(thirdPartyContract.address)
        ).to.be.false

        await expect(tx)
          .to.emit(maintainerProxy, "MaintainerUnauthorized")
          .withArgs(thirdPartyContract.address)
      })
    })
  })

  describe("updateBridge", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy.connect(thirdParty).updateBridge(thirdParty.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await maintainerProxy
          .connect(governance)
          .updateBridge(thirdParty.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the bridge", async () => {
        expect(await maintainerProxy.bridge()).to.equal(thirdParty.address)
      })

      it("should emit the BridgeUpdated event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "BridgeUpdated")
          .withArgs(thirdParty.address)
      })
    })
  })

  describe("updateGasOffsetParameters", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          maintainerProxy
            .connect(thirdParty)
            .updateGasOffsetParameters(40, 41, 42, 43, 44, 45, 46)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransaction

      before(async () => {
        await createSnapshot()
        tx = await maintainerProxy
          .connect(governance)
          .updateGasOffsetParameters(40, 41, 42, 43, 44, 45, 46)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit the GasOffsetParametersUpdated event", async () => {
        await expect(tx)
          .to.emit(maintainerProxy, "GasOffsetParametersUpdated")
          .withArgs(40, 41, 42, 43, 44, 45, 46)
      })
    })
  })

  interface SweepScenarioOutcome {
    tx: ContractTransaction
    initThirdPartyBalance: BigNumber
  }

  interface RedemptionScenarioOutcome {
    tx: ContractTransaction
    initThirdPartyBalance: BigNumber
  }

  interface MovingFundsScenarioOutcome {
    tx: ContractTransaction
    initThirdPartyBalance: BigNumber
  }

  async function makeRedemptionAllowance(
    redeemer: SignerWithAddress,
    amount: BigNumberish
  ) {
    // Simulate the redeemer has a TBTC balance allowing to make the request.
    await bank.setBalance(redeemer.address, amount)
    // Redeemer must allow the Bridge to spent the requested amount.
    await bank
      .connect(redeemer)
      .increaseBalanceAllowance(bridge.address, amount)
  }

  async function runSweepScenario(
    data: DepositSweepTestData
  ): Promise<SweepScenarioOutcome> {
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

    for (let i = 0; i < data.deposits.length; i++) {
      const { fundingTx, reveal } = data.deposits[i]
      // eslint-disable-next-line no-await-in-loop
      await bridge.revealDeposit(fundingTx, reveal)
    }

    const initThirdPartyBalance = await provider.getBalance(thirdParty.address)

    const tx = await maintainerProxy
      .connect(thirdParty)
      .submitDepositSweepProof(data.sweepTx, data.sweepProof, data.mainUtxo)

    return { tx, initThirdPartyBalance }
  }

  async function runRedemptionScenario(
    data: RedemptionTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<RedemptionScenarioOutcome> {
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

    await bridge.setRedemptionDustThreshold(10000)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: data.wallet.pendingRedemptionsValue,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    for (let i = 0; i < data.redemptionRequests.length; i++) {
      const { redeemer, redeemerOutputScript, amount } =
        data.redemptionRequests[i]

      /* eslint-disable no-await-in-loop */
      const redeemerSigner = await impersonateAccount(redeemer, {
        from: governance,
        value: 100,
      })

      await makeRedemptionAllowance(redeemerSigner, amount)

      await bridge
        .connect(redeemerSigner)
        .requestRedemption(
          data.wallet.pubKeyHash,
          data.mainUtxo,
          redeemerOutputScript,
          amount
        )
      /* eslint-enable no-await-in-loop */
    }

    if (beforeProofActions) {
      await beforeProofActions()
    }

    const initThirdPartyBalance = await provider.getBalance(thirdParty.address)

    const tx = await maintainerProxy
      .connect(thirdParty)
      .submitRedemptionProof(
        data.redemptionTx,
        data.redemptionProof,
        data.mainUtxo,
        data.wallet.pubKeyHash
      )

    return {
      tx,
      initThirdPartyBalance,
    }
  }

  async function runMovingFundsScenario(
    data: MovingFundsTestData,
    beforeProofActions?: () => Promise<void>
  ): Promise<MovingFundsScenarioOutcome> {
    relay.getPrevEpochDifficulty.returns(data.chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(data.chainDifficulty)

    // Simulate the wallet is a registered one.
    await bridge.setWallet(data.wallet.pubKeyHash, {
      ecdsaWalletID: data.wallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: await lastBlockTime(),
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: data.wallet.state,
      movingFundsTargetWalletsCommitmentHash:
        data.targetWalletsCommitment.length > 0
          ? ethers.utils.solidityKeccak256(
              ["bytes20[]"],
              [data.targetWalletsCommitment]
            )
          : ethers.constants.HashZero,
    })
    // Simulate the prepared main UTXO belongs to the wallet.
    await bridge.setWalletMainUtxo(data.wallet.pubKeyHash, data.mainUtxo)

    if (beforeProofActions) {
      await beforeProofActions()
    }

    const initThirdPartyBalance = await provider.getBalance(thirdParty.address)

    const tx = await maintainerProxy
      .connect(thirdParty)
      .submitMovingFundsProof(
        data.movingFundsTx,
        data.movingFundsProof,
        data.mainUtxo,
        data.wallet.pubKeyHash
      )

    relay.getCurrentEpochDifficulty.reset()
    relay.getPrevEpochDifficulty.reset()

    return { tx, initThirdPartyBalance }
  }
})
