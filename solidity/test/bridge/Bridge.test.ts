import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import type { Bank, Bridge, TestRelay } from "../../typechain"
import {
  MultipleDepositsNoPreviousSweep,
  MultipleDepositsWithPreviousSweep,
  NO_PREVIOUS_SWEEP,
  SingleP2SHDeposit,
  SingleP2WSHDeposit,
  SinglePreviousSweep,
  SweepTestData,
} from "../data/sweep"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero

const fixture = async () => {
  const [deployer, governance, thirdParty] = await ethers.getSigners()

  const Bank = await ethers.getContractFactory("Bank")
  const bank: Bank = await Bank.deploy()
  await bank.deployed()

  const TestRelay = await ethers.getContractFactory("TestRelay")
  const relay: TestRelay = await TestRelay.deploy()
  await relay.deployed()

  const Bridge = await ethers.getContractFactory("Bridge")
  const bridge: Bridge = await Bridge.deploy(bank.address, relay.address, 1)
  await bridge.deployed()

  await bank.updateBridge(bridge.address)
  await bridge.connect(deployer).transferOwnership(governance.address)

  return {
    governance,
    thirdParty,
    bank,
    relay,
    bridge,
  }
}

describe("Bridge", () => {
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress

  let bank: Bank
  let relay: TestRelay
  let bridge: Bridge

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ governance, thirdParty, bank, relay, bridge } =
      await waffle.loadFixture(fixture))
  })

  describe("isVaultTrusted", () => {
    const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"

    it("should not trust a vault by default", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await bridge.isVaultTrusted(vault)).to.be.false
    })
  })

  describe("setVaultStatus", () => {
    const vault = "0x2553E09f832c9f5C656808bb7A24793818877732"

    describe("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          bridge.connect(thirdParty).setVaultStatus(vault, true)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    describe("when called by the governance", () => {
      let tx: ContractTransaction

      describe("when setting vault status as trusted", () => {
        before(async () => {
          await createSnapshot()
          tx = await bridge.connect(governance).setVaultStatus(vault, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should correctly update vault status", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await bridge.isVaultTrusted(vault)).to.be.true
        })

        it("should emit VaultStatusUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "VaultStatusUpdated")
            .withArgs(vault, true)
        })
      })

      describe("when setting vault status as no longer trusted", () => {
        before(async () => {
          await createSnapshot()
          await bridge.connect(governance).setVaultStatus(vault, true)
          tx = await bridge.connect(governance).setVaultStatus(vault, false)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should correctly update vault status", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await bridge.isVaultTrusted(vault)).to.be.false
        })

        it("should emit VaultStatusUpdated event", async () => {
          await expect(tx)
            .to.emit(bridge, "VaultStatusUpdated")
            .withArgs(vault, false)
        })
      })
    })
  })

  describe("revealDeposit", () => {
    // Data of a proper P2SH deposit funding transaction. Little-endian hash is:
    // 0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2 and
    // this is the same as `expectedP2SHDepositData.transaction` mentioned in
    // tbtc-ts/test/deposit.test.ts file.
    const P2SHFundingTx = {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x02102700000000000017a9142c1444d23936c57bdd8b3e67e5938a5440c" +
        "da455877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
        "140d2726",
      locktime: "0x00000000",
    }

    // Data of a proper P2WSH deposit funding transaction. Little-endian hash is:
    // 0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e and
    // this is the same as `expectedP2WSHDepositData.transaction` mentioned in
    // tbtc-ts/test/deposit.test.ts file.
    const P2WSHFundingTx = {
      version: "0x01000000",
      inputVector:
        "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
        "c2b952f0100000000ffffffff",
      outputVector:
        "0x021027000000000000220020df74a2e385542c87acfafa564ea4bc4fc4e" +
        "b87d2b6a37d6c3b64722be83c636f10d73b00000000001600147ac2d9378a" +
        "1c47e589dfb8095ca95ed2140d2726",
      locktime: "0x00000000",
    }

    // Data matching the redeem script locking the funding output of
    // P2SHFundingTx and P2WSHFundingTx.
    const reveal = {
      fundingOutputIndex: 0,
      depositor: "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
      blindingFactor: "0xf9f0c90d00039523",
      // HASH160 of 03989d253b17a6a0f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d9.
      walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
      // HASH160 of 0300d6f28a2f6bf9836f57fcda5d284c9a8f849316119779f0d6090830d97763a9.
      refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
      refundLocktime: "0x60bcea61",
      vault: "0x594cfd89700040163727828AE20B52099C58F02C",
    }

    before(async () => {
      await bridge.connect(governance).setVaultStatus(reveal.vault, true)
    })

    context("when funding transaction is P2SH", () => {
      context("when funding output script hash is correct", () => {
        context("when deposit was not revealed yet", () => {
          context("when deposit is routed to a trusted vault", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await bridge.revealDeposit(P2SHFundingTx, reveal)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should store proper deposit data", async () => {
              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
              const depositKey = ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [
                  "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                  reveal.fundingOutputIndex,
                ]
              )

              const deposit = await bridge.deposits(depositKey)

              // Should contain: depositor, amount, revealedAt, vault, sweptAt.
              expect(deposit.length).to.be.equal(5)
              // Depositor address, same as in `reveal.depositor`.
              expect(deposit[0]).to.be.equal(
                "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
              )
              // Deposit amount in satoshi. In this case it's 10000 satoshi
              // because the P2SH deposit transaction set this value for the
              // funding output.
              expect(deposit[1]).to.be.equal(10000)
              // Revealed time should be set.
              expect(deposit[2]).to.be.equal(await lastBlockTime())
              // Deposit vault, same as in `reveal.vault`.
              expect(deposit[3]).to.be.equal(
                "0x594cfd89700040163727828AE20B52099C58F02C"
              )
              // Swept time should be unset.
              expect(deposit[4]).to.be.equal(0)
            })

            it("should emit DepositRevealed event", async () => {
              await expect(tx)
                .to.emit(bridge, "DepositRevealed")
                .withArgs(
                  "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                  reveal.fundingOutputIndex,
                  "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                  "0xf9f0c90d00039523",
                  "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                  "0x28e081f285138ccbe389c1eb8985716230129f89",
                  "0x60bcea61",
                  reveal.vault
                )
            })
          })

          context("when deposit is not routed to a vault", () => {
            let tx: ContractTransaction
            let nonRoutedReveal

            before(async () => {
              await createSnapshot()

              nonRoutedReveal = { ...reveal }
              nonRoutedReveal.vault = ZERO_ADDRESS
              tx = await bridge.revealDeposit(P2SHFundingTx, nonRoutedReveal)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should accept the deposit", async () => {
              await expect(tx)
                .to.emit(bridge, "DepositRevealed")
                .withArgs(
                  "0x17350f81cdb61cd8d7014ad1507d4af8d032b75812cf88d2c636c1c022991af2",
                  reveal.fundingOutputIndex,
                  "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                  "0xf9f0c90d00039523",
                  "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                  "0x28e081f285138ccbe389c1eb8985716230129f89",
                  "0x60bcea61",
                  ZERO_ADDRESS
                )
            })
          })

          context("when deposit is routed to a non-trusted vault", () => {
            let nonTrustedVaultReveal

            before(async () => {
              await createSnapshot()

              nonTrustedVaultReveal = { ...reveal }
              nonTrustedVaultReveal.vault =
                "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.revealDeposit(P2SHFundingTx, nonTrustedVaultReveal)
              ).to.be.revertedWith("Vault is not trusted")
            })
          })
        })

        context("when deposit was already revealed", () => {
          before(async () => {
            await createSnapshot()

            await bridge.revealDeposit(P2SHFundingTx, reveal)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.revealDeposit(P2SHFundingTx, reveal)
            ).to.be.revertedWith("Deposit already revealed")
          })
        })
      })

      context("when funding output script hash is wrong", () => {
        it("should revert", async () => {
          // Corrupt reveal data by setting a wrong depositor address.
          const corruptedReveal = { ...reveal }
          corruptedReveal.depositor =
            "0x24CbaB95C69e5bcbE328252F957A39d906eE75f3"

          await expect(
            bridge.revealDeposit(P2SHFundingTx, corruptedReveal)
          ).to.be.revertedWith("Wrong 20-byte script hash")
        })
      })
    })

    context("when funding transaction is P2WSH", () => {
      context("when funding output script hash is correct", () => {
        context("when deposit was not revealed yet", () => {
          context("when deposit is routed to a trusted vault", () => {
            let tx: ContractTransaction

            before(async () => {
              await createSnapshot()

              tx = await bridge.revealDeposit(P2WSHFundingTx, reveal)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should store proper deposit data", async () => {
              // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
              const depositKey = ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [
                  "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                  reveal.fundingOutputIndex,
                ]
              )

              const deposit = await bridge.deposits(depositKey)

              // Should contain: depositor, amount, revealedAt and vault.
              expect(deposit.length).to.be.equal(5)
              // Depositor address, same as in `reveal.depositor`.
              expect(deposit[0]).to.be.equal(
                "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637"
              )
              // Deposit amount in satoshi. In this case it's 10000 satoshi
              // because the P2WSH deposit transaction set this value for the
              // funding output.
              expect(deposit[1]).to.be.equal(10000)
              // Revealed time should be set.
              expect(deposit[2]).to.be.equal(await lastBlockTime())
              // Deposit vault, same as in `reveal.vault`.
              expect(deposit[3]).to.be.equal(
                "0x594cfd89700040163727828AE20B52099C58F02C"
              )
              // Swept time should be unset.
              expect(deposit[4]).to.be.equal(0)
            })

            it("should emit DepositRevealed event", async () => {
              await expect(tx)
                .to.emit(bridge, "DepositRevealed")
                .withArgs(
                  "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                  reveal.fundingOutputIndex,
                  "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                  "0xf9f0c90d00039523",
                  "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                  "0x28e081f285138ccbe389c1eb8985716230129f89",
                  "0x60bcea61",
                  reveal.vault
                )
            })
          })

          context("when deposit is not routed to a vault", () => {
            let tx: ContractTransaction
            let nonRoutedReveal

            before(async () => {
              await createSnapshot()

              nonRoutedReveal = { ...reveal }
              nonRoutedReveal.vault = ZERO_ADDRESS
              tx = await bridge.revealDeposit(P2WSHFundingTx, nonRoutedReveal)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should accept the deposit", async () => {
              await expect(tx)
                .to.emit(bridge, "DepositRevealed")
                .withArgs(
                  "0x6a81de17ce3da1eadc833c5fd9d85dac307d3b78235f57afbcd9f068fc01b99e",
                  reveal.fundingOutputIndex,
                  "0x934B98637cA318a4D6E7CA6ffd1690b8e77df637",
                  "0xf9f0c90d00039523",
                  "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
                  "0x28e081f285138ccbe389c1eb8985716230129f89",
                  "0x60bcea61",
                  ZERO_ADDRESS
                )
            })
          })

          context("when deposit is routed to a non-trusted vault", () => {
            let nonTrustedVaultReveal

            before(async () => {
              await createSnapshot()

              nonTrustedVaultReveal = { ...reveal }
              nonTrustedVaultReveal.vault =
                "0x92499afEAD6c41f757Ec3558D0f84bf7ec5aD967"
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                bridge.revealDeposit(P2WSHFundingTx, nonTrustedVaultReveal)
              ).to.be.revertedWith("Vault is not trusted")
            })
          })
        })

        context("when deposit was already revealed", () => {
          before(async () => {
            await createSnapshot()

            await bridge.revealDeposit(P2WSHFundingTx, reveal)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              bridge.revealDeposit(P2WSHFundingTx, reveal)
            ).to.be.revertedWith("Deposit already revealed")
          })
        })
      })

      context("when funding output script hash is wrong", () => {
        it("should revert", async () => {
          // Corrupt reveal data by setting a wrong depositor address.
          const corruptedReveal = { ...reveal }
          corruptedReveal.depositor =
            "0x24CbaB95C69e5bcbE328252F957A39d906eE75f3"

          await expect(
            bridge.revealDeposit(P2WSHFundingTx, corruptedReveal)
          ).to.be.revertedWith("Wrong 32-byte script hash")
        })
      })
    })

    context("when funding transaction is neither P2SH nor P2WSH", () => {
      it("should revert", async () => {
        // Corrupt transaction output data by making a 21-byte script hash.
        const corruptedP2SHFundingTx = { ...P2SHFundingTx }
        corruptedP2SHFundingTx.outputVector =
          "0x02102700000000000017a9156a6ade1c799a3e5a59678e776f21be14d66dc" +
          "15ed8877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
          "140d2726"

        await expect(
          bridge.revealDeposit(corruptedP2SHFundingTx, reveal)
        ).to.be.revertedWith("Wrong script hash length")
      })
    })
  })

  describe("sweep", () => {
    context("when transaction proof is valid", () => {
      context("when there is only one output", () => {
        context("when wallet public key hash length is 20 bytes", () => {
          context("when previous sweep data are valid", () => {
            context("when there is only one input", () => {
              context(
                "when the single input is a revealed unswept P2SH deposit",
                () => {
                  let tx: ContractTransaction
                  const data: SweepTestData = SingleP2SHDeposit

                  before(async () => {
                    await createSnapshot()

                    tx = await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark deposit as swept", async () => {
                    // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                    const depositKey = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint32"],
                      [
                        data.deposits[0].fundingTx.hash,
                        data.deposits[0].reveal.fundingOutputIndex,
                      ]
                    )

                    const deposit = await bridge.deposits(depositKey)

                    // Swept time is the last item.
                    expect(deposit[4]).to.be.equal(await lastBlockTime())
                  })

                  it("should save sweep hash for given wallet", async () => {
                    // Take wallet public key hash from first deposit. All deposits
                    // in same sweep batch should have the same value of that field.
                    const { walletPubKeyHash } = data.deposits[0].reveal

                    const sweepHash = await bridge.sweeps(walletPubKeyHash)

                    // Amount can be checked by opening the sweep tx in a Bitcoin
                    // testnet explorer. In this case, the sum of inputs is
                    // 20000 satoshi (from the single deposit) and there is a
                    // fee of 1500 so the output value is 18500.
                    const expectedSweepHash = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint64"],
                      [data.sweepTx.hash, 18500]
                    )

                    expect(sweepHash).to.be.equal(expectedSweepHash)
                  })

                  it("should update the depositor's balance", async () => {
                    // The sum of sweep tx inputs is 20000 satoshi. The output
                    // value is 18500 so the fee is 1500. There is only one
                    // deposit so it incurs the entire fee.
                    expect(
                      await bank.balanceOf(data.deposits[0].reveal.depositor)
                    ).to.be.equal(18500)
                  })
                }
              )

              context(
                "when the single input is a revealed unswept P2WSH deposit",
                () => {
                  let tx: ContractTransaction
                  const data: SweepTestData = SingleP2WSHDeposit

                  before(async () => {
                    await createSnapshot()

                    tx = await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark deposit as swept", async () => {
                    // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                    const depositKey = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint32"],
                      [
                        data.deposits[0].fundingTx.hash,
                        data.deposits[0].reveal.fundingOutputIndex,
                      ]
                    )

                    const deposit = await bridge.deposits(depositKey)

                    // Swept time is the last item.
                    expect(deposit[4]).to.be.equal(await lastBlockTime())
                  })

                  it("should save sweep hash for given wallet", async () => {
                    // Take wallet public key hash from first deposit. All deposits
                    // in same sweep batch should have the same value of that field.
                    const { walletPubKeyHash } = data.deposits[0].reveal

                    const sweepHash = await bridge.sweeps(walletPubKeyHash)

                    // Amount can be checked by opening the sweep tx in a Bitcoin
                    // testnet explorer. In this case, the sum of inputs is
                    // 80000 satoshi (from the single deposit) and there is a
                    // fee of 2000 so the output value is 78000.
                    const expectedSweepHash = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint64"],
                      [data.sweepTx.hash, 78000]
                    )

                    expect(sweepHash).to.be.equal(expectedSweepHash)
                  })

                  it("should update the depositor's balance", async () => {
                    // The sum of sweep tx inputs is 80000 satoshi. The output
                    // value is 78000 so the fee is 2000. There is only one
                    // deposit so it incurs the entire fee.
                    expect(
                      await bank.balanceOf(data.deposits[0].reveal.depositor)
                    ).to.be.equal(78000)
                  })
                }
              )

              context(
                "when the single input is the expected previous sweep",
                () => {
                  let tx: ContractTransaction
                  const previousData: SweepTestData = SingleP2SHDeposit
                  const data: SweepTestData = SinglePreviousSweep

                  before(async () => {
                    await createSnapshot()

                    // Make the first sweep which is actually the predecessor
                    // of the sweep tested within this scenario.
                    await runSweepScenario(previousData)

                    tx = await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should save sweep hash for given wallet", async () => {
                    // There is no deposits we could use to extract the wallet
                    // public key hash but we can also take it straight from
                    // sweep tx output.
                    const walletPubKeyHash =
                      "0x8db50eb52063ea9d98b3eac91489a90f738986f6"

                    const sweepHash = await bridge.sweeps(walletPubKeyHash)

                    // Amount can be checked by opening the sweep tx in a Bitcoin
                    // testnet explorer. In this case, the sum of inputs is
                    // 18500 satoshi (from the single deposit) and there is a
                    // fee of 2000 so the output value is 16500.
                    const expectedSweepHash = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint64"],
                      [data.sweepTx.hash, 16500]
                    )

                    expect(sweepHash).to.be.equal(expectedSweepHash)
                  })

                  it("should not increase any balances", async () => {
                    await expect(tx).to.not.emit(bank, "BalanceIncreased")
                  })
                }
              )

              context(
                "when the single input is a revealed but already swept deposit",
                () => {
                  const data: SweepTestData = SingleP2SHDeposit

                  before(async () => {
                    await createSnapshot()

                    // Make a proper sweep to turn the tested deposit into
                    // the swept state.
                    await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    // Previous sweep parameter must point to the properly
                    // made sweep to avoid revert at validation stage.
                    const previousSweep = {
                      txHash: data.sweepTx.hash,
                      txOutputValue: 18500,
                    }

                    // Try replaying the already done sweep.
                    await expect(
                      bridge.sweep(data.sweepTx, data.sweepProof, previousSweep)
                    ).to.be.revertedWith("Deposit already swept")
                  })
                }
              )

              context("when the single input is an unknown", () => {
                const data: SweepTestData = SingleP2SHDeposit

                before(async () => {
                  await createSnapshot()

                  // Necessary to pass the proof validation.
                  await relay.setCurrentEpochDifficulty(data.chainDifficulty)
                  await relay.setPrevEpochDifficulty(data.chainDifficulty)
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  // Try to sweep a deposit which was not revealed before and
                  // is unknown from system's point of view.
                  await expect(
                    bridge.sweep(
                      data.sweepTx,
                      data.sweepProof,
                      NO_PREVIOUS_SWEEP
                    )
                  ).to.be.revertedWith("Unknown input type")
                })
              })
            })

            // Since P2SH vs P2WSH path has been already checked in the scenario
            // "when there is only one input", we no longer differentiate deposits
            // using that criterion during "when there are multiple inputs" scenario.
            context("when there are multiple inputs", () => {
              context(
                "when input vector consists only of revealed unswept " +
                  "deposits and the expected previous sweep",
                () => {
                  let tx: ContractTransaction
                  const previousData: SweepTestData =
                    MultipleDepositsNoPreviousSweep
                  const data: SweepTestData = MultipleDepositsWithPreviousSweep

                  before(async () => {
                    await createSnapshot()

                    // Make the first sweep which is actually the predecessor
                    // of the sweep tested within this scenario.
                    await runSweepScenario(previousData)

                    tx = await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark deposits as swept", async () => {
                    for (let i = 0; i < data.deposits.length; i++) {
                      // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                      const depositKey = ethers.utils.solidityKeccak256(
                        ["bytes32", "uint32"],
                        [
                          data.deposits[i].fundingTx.hash,
                          data.deposits[i].reveal.fundingOutputIndex,
                        ]
                      )

                      // eslint-disable-next-line no-await-in-loop
                      const deposit = await bridge.deposits(depositKey)

                      // Swept time is the last item.
                      expect(deposit[4]).to.be.equal(
                        // eslint-disable-next-line no-await-in-loop
                        await lastBlockTime(),
                        `Deposit with index ${i} has an unexpected swept time`
                      )
                    }
                  })

                  it("should save sweep hash for given wallet", async () => {
                    // Take wallet public key hash from first deposit. All deposits
                    // in same sweep batch should have the same value of that field.
                    const { walletPubKeyHash } = data.deposits[0].reveal

                    const sweepHash = await bridge.sweeps(walletPubKeyHash)

                    // Amount can be checked by opening the sweep tx in a Bitcoin
                    // testnet explorer. In this case, the sum of inputs is
                    // 4148000 satoshi and there is a fee of 2999 so the output
                    // value is 4145001.
                    const expectedSweepHash = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint64"],
                      [data.sweepTx.hash, 4145001]
                    )

                    expect(sweepHash).to.be.equal(expectedSweepHash)
                  })

                  it("should update the depositors balances", async () => {
                    // The sum of sweep tx inputs is 4148000 satoshi. The output
                    // value is 4145001 so the fee is 2999. There is 5 deposits
                    // so 599 satoshi fee should be incurred per deposit.
                    expect(
                      await bank.balanceOf(data.deposits[0].reveal.depositor)
                    ).to.be.equal(219401)
                    expect(
                      await bank.balanceOf(data.deposits[1].reveal.depositor)
                    ).to.be.equal(759401)
                    expect(
                      await bank.balanceOf(data.deposits[2].reveal.depositor)
                    ).to.be.equal(939401)
                    expect(
                      await bank.balanceOf(data.deposits[3].reveal.depositor)
                    ).to.be.equal(879401)
                    expect(
                      await bank.balanceOf(data.deposits[4].reveal.depositor)
                    ).to.be.equal(289401)
                  })
                }
              )

              context(
                "when input vector consists only of revealed unswept " +
                  "deposits but there is no previous sweep since it is not expected",
                () => {
                  let tx: ContractTransaction
                  const data: SweepTestData = MultipleDepositsNoPreviousSweep

                  before(async () => {
                    await createSnapshot()

                    tx = await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should mark deposits as swept", async () => {
                    for (let i = 0; i < data.deposits.length; i++) {
                      // Deposit key is keccak256(fundingTxHash | fundingOutputIndex).
                      const depositKey = ethers.utils.solidityKeccak256(
                        ["bytes32", "uint32"],
                        [
                          data.deposits[i].fundingTx.hash,
                          data.deposits[i].reveal.fundingOutputIndex,
                        ]
                      )

                      // eslint-disable-next-line no-await-in-loop
                      const deposit = await bridge.deposits(depositKey)

                      // Swept time is the last item.
                      expect(deposit[4]).to.be.equal(
                        // eslint-disable-next-line no-await-in-loop
                        await lastBlockTime(),
                        `Deposit with index ${i} has an unexpected swept time`
                      )
                    }
                  })

                  it("should save sweep hash for given wallet", async () => {
                    // Take wallet public key hash from first deposit. All deposits
                    // in same sweep batch should have the same value of that field.
                    const { walletPubKeyHash } = data.deposits[0].reveal

                    const sweepHash = await bridge.sweeps(walletPubKeyHash)

                    // Amount can be checked by opening the sweep tx in a Bitcoin
                    // testnet explorer. In this case, the sum of inputs is
                    // 1060000 satoshi and there is a fee of 2000 so the output
                    // value is 1058000.
                    const expectedSweepHash = ethers.utils.solidityKeccak256(
                      ["bytes32", "uint64"],
                      [data.sweepTx.hash, 1058000]
                    )

                    expect(sweepHash).to.be.equal(expectedSweepHash)
                  })

                  it("should update the depositors balances", async () => {
                    // The sum of sweep tx inputs is 1060000 satoshi. The output
                    // value is 1058000 so the fee is 2000. There is 5 deposits
                    // so 400 satoshi fee should be incurred per deposit.
                    expect(
                      await bank.balanceOf(data.deposits[0].reveal.depositor)
                    ).to.be.equal(29600)
                    expect(
                      await bank.balanceOf(data.deposits[1].reveal.depositor)
                    ).to.be.equal(9600)
                    expect(
                      await bank.balanceOf(data.deposits[2].reveal.depositor)
                    ).to.be.equal(209600)
                    expect(
                      await bank.balanceOf(data.deposits[3].reveal.depositor)
                    ).to.be.equal(369600)
                    expect(
                      await bank.balanceOf(data.deposits[4].reveal.depositor)
                    ).to.be.equal(439600)
                  })
                }
              )

              context(
                "when input vector consists only of revealed unswept " +
                  "deposits but there is no previous sweep despite it is expected",
                () => {
                  const previousData: SweepTestData = SingleP2WSHDeposit
                  const data: SweepTestData = {
                    ...MultipleDepositsNoPreviousSweep,
                  }

                  before(async () => {
                    await createSnapshot()

                    // Make the first sweep to create an on-chain expectation
                    // that the tested sweep will contain the previous sweep
                    // input.
                    await runSweepScenario(previousData)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    // Use sweep data which doesn't reference any previous
                    // sweep data. Also, pass a correct previous sweep parameter
                    // in order to pass previous sweep validation in the contract.
                    data.previousSweep = {
                      txHash: previousData.sweepTx.hash,
                      txOutputValue: 78000,
                    }

                    await expect(runSweepScenario(data)).to.be.revertedWith(
                      "Previous sweep output not present in sweep transaction inputs"
                    )
                  })
                }
              )

              context(
                "when input vector contains a revealed but already swept deposit",
                () => {
                  const data: SweepTestData = MultipleDepositsNoPreviousSweep

                  before(async () => {
                    await createSnapshot()

                    // Make a proper sweep to turn the tested deposits into
                    // the swept state.
                    await runSweepScenario(data)
                  })

                  after(async () => {
                    await restoreSnapshot()
                  })

                  it("should revert", async () => {
                    // Previous sweep parameter must point to the properly
                    // made sweep to avoid revert at validation stage.
                    const previousSweep = {
                      txHash: data.sweepTx.hash,
                      txOutputValue: 1058000,
                    }

                    // Try replaying the already done sweep.
                    await expect(
                      bridge.sweep(data.sweepTx, data.sweepProof, previousSweep)
                    ).to.be.revertedWith("Deposit already swept")
                  })
                }
              )

              context("when input vector contains an unknown input", () => {
                const data: SweepTestData = MultipleDepositsWithPreviousSweep

                before(async () => {
                  await createSnapshot()
                })

                after(async () => {
                  await restoreSnapshot()
                })

                it("should revert", async () => {
                  // Used test data contains an actual previous sweep input
                  // but that previous sweep proof was not submitted on-chain
                  // so it is unknown from contract's perspective.
                  await expect(runSweepScenario(data)).to.be.revertedWith(
                    "Unknown input type"
                  )
                })
              })
            })
          })

          context("when previous sweep data are invalid", () => {
            const previousData: SweepTestData = MultipleDepositsNoPreviousSweep
            const data: SweepTestData = JSON.parse(
              JSON.stringify(MultipleDepositsWithPreviousSweep)
            )

            before(async () => {
              await createSnapshot()

              // Make the first sweep which is actually the predecessor
              // of the sweep tested within this scenario.
              await runSweepScenario(previousData)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              // Forge the previous sweep parameter to force validation crash.
              data.previousSweep = NO_PREVIOUS_SWEEP

              await expect(runSweepScenario(data)).to.be.revertedWith(
                "Invalid previous sweep data"
              )
            })
          })
        })

        context(
          "when wallet public key hash length is other than 20 bytes",
          () => {
            before(async () => {
              await createSnapshot()

              // Necessary to pass the proof validation.
              await relay.setCurrentEpochDifficulty(20870012)
              await relay.setPrevEpochDifficulty(20870012)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              // To test this case, an arbitrary transaction with single
              // P2WSH output is used. In that case, the wallet public key
              // hash will have a wrong length of 32 bytes. Used transaction:
              // https://live.blockcypher.com/btc-testnet/tx/af56cae479215c5e44a6a4db0eeb10a1abdd98020a6c01b9c26ea7b829aa2809
              const sweepTx = {
                version: "0x01000000",
                inputVector:
                  "0x01d32586237f6a832c3aa324bb83151e43e6cca2e4312d676f14" +
                  "dbbd6b1f04f4680100000000ffffffff",
                outputVector:
                  "0x012ea3090000000000220020af802a76c10b6a646fff8d358241" +
                  "c121c9be1c53628adb26bd6554631bfc7d8b",
                locktime: "0x00000000",
              }

              const sweepProof = {
                merkleProof:
                  "0xf09955dcfb05b1c369eb9f58b6e583e49f47b9b8d6e63537dcac" +
                  "10bf0cc5407d06e76ee2d75b5be5ec365a4c1272067b786d79a64d" +
                  "c015eb40dedd3c813f4dee40c149ee21036bba713d14b3c22454ef" +
                  "44c958293a015e9e186983f20c46d74a29ca5f705913e210229078" +
                  "af993e89d90bb731dab3c8cf8907d683ab60faca1866036118737e" +
                  "07aaa74d489e80f773b4d9ff2887a4855b805aaf1b5a7a1b0bf382" +
                  "be8dab2401ec758a705b648724f93d14c3b72ce4fb3cd7d414e8a1" +
                  "75ef173e",
                txIndexInBlock: 20,
                bitcoinHeaders:
                  "0x0000e020fbeb3a876746438f1fd793add061b0b7af2f88a387ee" +
                  "f5b38600000000000000933a0cec98a028727df04dafbbe691c8ad" +
                  "442351db7321c9f7cc169aa9f64a9a7af6f361cbcd001a65073028",
              }

              await expect(
                bridge.sweep(sweepTx, sweepProof, NO_PREVIOUS_SWEEP)
              ).to.be.revertedWith(
                "Wallet public key hash should have 20 bytes"
              )
            })
          }
        )
      })

      context("when output count is other than one", () => {
        before(async () => {
          await createSnapshot()

          // Necessary to pass the proof validation.
          await relay.setCurrentEpochDifficulty(1)
          await relay.setPrevEpochDifficulty(1)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // To test this case, an arbitrary transaction with two
          // outputs is used. Used transaction:
          // https://live.blockcypher.com/btc-testnet/tx/af56cae479215c5e44a6a4db0eeb10a1abdd98020a6c01b9c26ea7b829aa2809
          const sweepTx = {
            version: "0x01000000",
            inputVector:
              "0x011d9b71144a3ddbb56dd099ee94e6dd8646d7d1eb37fe1195367e6f" +
              "a844a388e7010000006a47304402206f8553c07bcdc0c3b90631188810" +
              "3d623ca9096ca0b28b7d04650a029a01fcf9022064cda02e39e65ace71" +
              "2029845cfcf58d1b59617d753c3fd3556f3551b609bbb00121039d61d6" +
              "2dcd048d3f8550d22eb90b4af908db60231d117aeede04e7bc11907bfa" +
              "ffffffff",
            outputVector:
              "0x02204e00000000000017a9143ec459d0f3c29286ae5df5fcc421e278" +
              "6024277e87a6c2140000000000160014e257eccafbc07c381642ce6e7e" +
              "55120fb077fbed",
            locktime: "0x00000000",
          }

          const sweepProof = {
            merkleProof:
              "0x161d24e53fc61db783f0271d45ef43b76e69fc975cf38decbba654ae" +
              "3d09f5d1a060c3448c0c06ededa9749e559ffa65e2d5f3abac749b278e" +
              "1189aa5b49a499b032963ea3fad337c4a9c8df4e748865503b5aea083f" +
              "b32efe4dca057a741a020790cde5b50acc2cdbd231e43594036388f1e5" +
              "d20ebba319465c56e85bf4e4b4f8b7276402b6c114000c59149494f852" +
              "84507c253bbc505fec7ea50f370aa150",
            txIndexInBlock: 8,
            bitcoinHeaders:
              "0x00000020fbee5222c9fc99c8071cee3fed39b4c0d39f41075469ce9f" +
              "52000000000000003fd9c72d0611b373ce2b1996e0ebb8bc36dc12d431" +
              "cae5b9371f343111f3d7519015da61ffff001dbddfb528000040208a9f" +
              "e49585b4cd8a94daeeb926c6f1e96151c74ae1ae0b18c6a6d564000000" +
              "0065c05d9ea40cace1b6b0ad0b8a9a18646096b54484fbdd96b1596560" +
              "f6999194a815da612ac0001a2e4c6405",
          }

          await expect(
            bridge.sweep(sweepTx, sweepProof, NO_PREVIOUS_SWEEP)
          ).to.be.revertedWith("Sweep transaction must have a single output")
        })
      })
    })

    context("when transaction proof is not valid", () => {
      context("when input vector is not valid", () => {
        const data: SweepTestData = JSON.parse(
          JSON.stringify(SingleP2SHDeposit)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the input vector by setting a compactSize uint claiming
          // there is no inputs at all.
          data.sweepTx.inputVector =
            "0x0079544f374199c68869ce7df906eeb0ee5c0506a512d903e3900d5752" +
            "e3e080c500000000c847304402205eff3ae003a5903eb33f32737e3442b6" +
            "516685a1addb19339c2d02d400cf67ce0220707435fc2a0577373c63c99d" +
            "242c30bea5959ec180169978d43ece50618fe0ff012103989d253b17a6a0" +
            "f41838b84ff0d20e8898f9d7b1a98f2564da4cc29dcf8581d94c5c14934b" +
            "98637ca318a4d6e7ca6ffd1690b8e77df6377508f9f0c90d000395237576" +
            "a9148db50eb52063ea9d98b3eac91489a90f738986f68763ac6776a914e2" +
            "57eccafbc07c381642ce6e7e55120fb077fbed8804e0250162b175ac68ff" +
            "ffffff"

          await expect(runSweepScenario(data)).to.be.revertedWith(
            "Invalid input vector provided"
          )
        })
      })

      context("when output vector is not valid", () => {
        const data: SweepTestData = JSON.parse(
          JSON.stringify(SingleP2SHDeposit)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the output vector by setting a compactSize uint claiming
          // there is no outputs at all.
          data.sweepTx.outputVector =
            "0x0044480000000000001600148db50eb52063ea9d98b3eac91489a90f73" +
            "8986f6"

          await expect(runSweepScenario(data)).to.be.revertedWith(
            "Invalid output vector provided"
          )
        })
      })

      context("when merkle proof is not valid", () => {
        const data: SweepTestData = JSON.parse(
          JSON.stringify(SingleP2SHDeposit)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // Corrupt the merkle proof by changing tx index in block to an
          // invalid one. The proper one is 36 so any other will do the trick.
          data.sweepProof.txIndexInBlock = 30

          await expect(runSweepScenario(data)).to.be.revertedWith(
            "Tx merkle proof is not valid for provided header and tx hash"
          )
        })
      })

      context("when proof difficulty is not current nor previous", () => {
        const data: SweepTestData = JSON.parse(
          JSON.stringify(SingleP2SHDeposit)
        )

        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // To pass the proof validation, the difficulty returned by the relay
          // must be 22350181 for test data used in this scenario. Setting
          // a different value will cause difficulty comparison failure.
          data.chainDifficulty = 1

          await expect(runSweepScenario(data)).to.be.revertedWith(
            "Not at current or previous difficulty"
          )
        })
      })

      context("when headers chain length is not valid", () => {
        it("should revert", () => {
          // TODO: Implementation.
        })
      })

      context("when headers chain is not valid", () => {
        it("should revert", () => {
          // TODO: Implementation.
        })
      })

      context("when the work in the header is insufficient", () => {
        it("should revert", () => {
          // TODO: Implementation.
        })
      })

      context(
        "when accumulated difficulty in headers chain is insufficient",
        () => {
          it("should revert", () => {
            // TODO: Implementation.
          })
        }
      )
    })
  })

  async function runSweepScenario(
    data: SweepTestData
  ): Promise<ContractTransaction> {
    await relay.setCurrentEpochDifficulty(data.chainDifficulty)
    await relay.setPrevEpochDifficulty(data.chainDifficulty)

    for (let i = 0; i < data.deposits.length; i++) {
      const { fundingTx, reveal } = data.deposits[i]
      // eslint-disable-next-line no-await-in-loop
      await bridge.revealDeposit(fundingTx, reveal)
    }

    return bridge.sweep(data.sweepTx, data.sweepProof, data.previousSweep)
  }
})
