import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import { FakeContract } from "@defi-wonderland/smock"

import { walletState } from "../fixtures"
import bridgeFixture from "../fixtures/bridge"

import type {
  Bridge,
  BridgeStub,
  BridgeGovernance,
  TBTCVault,
  TBTC,
  IRelay,
  VendingMachine,
} from "../../typechain"
import { DepositSweepTestData, SingleP2SHDeposit } from "../data/deposit-sweep"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time

describe("TBTCVault - OptimisticMinting", () => {
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let tbtcVault: TBTCVault
  let tbtc: TBTC
  let vendingMachine: VendingMachine
  let relay: FakeContract<IRelay>

  let governance: SignerWithAddress
  let spvMaintainer: SignerWithAddress

  let minter: SignerWithAddress
  let guard: SignerWithAddress
  let thirdParty: SignerWithAddress

  // used by bridge.revealDeposit(fundingTx, depositRevealInfo)
  let fundingTx
  let depositRevealInfo

  // used by bridge.submitDepositSweepProof(sweepTx, sweepProof, mainUtxo)
  let sweepTx
  let sweepProof
  let mainUtxo
  let chainDifficulty: number

  // used by tbtcVault.optimisticMint(fundingTxHash, fundingOutputIndex)
  let fundingTxHash: string
  let fundingOutputIndex: number

  let depositKey: string

  before(async () => {
    const accounts = await getUnnamedAccounts()
    minter = await ethers.getSigner(accounts[0])
    guard = await ethers.getSigner(accounts[1])
    thirdParty = await ethers.getSigner(accounts[2])

    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      governance,
      spvMaintainer,
      relay,
      bridge,
      bridgeGovernance,
      tbtcVault,
      tbtc,
      vendingMachine,
    } = await waffle.loadFixture(bridgeFixture))

    // Deployment scripts deploy both `VendingMachine` and `TBTCVault` but they
    // do not transfer the ownership of `TBTC` token to `TBTCVault`.
    // We need to do it manually in tests covering `TBTCVault`'s behavior.
    const { keepTechnicalWalletTeam, keepCommunityMultiSig } =
      await helpers.signers.getNamedSigners()
    await vendingMachine
      .connect(keepTechnicalWalletTeam)
      .initiateVendingMachineUpgrade(tbtcVault.address)
    await increaseTime(await vendingMachine.GOVERNANCE_DELAY())
    await vendingMachine
      .connect(keepCommunityMultiSig)
      .finalizeVendingMachineUpgrade()

    // Deployment scripts to not set the vault's status as trusted. We need to
    // do it manually in tests covering `TBTCVault`'s behavior.
    await bridgeGovernance
      .connect(governance)
      .setVaultStatus(tbtcVault.address, true)

    // Set up test data needed to reveal a deposit via
    // bridge.revealDeposit(fundingTx, depositRevealInfo)
    const bitcoinTestData: DepositSweepTestData = JSON.parse(
      JSON.stringify(SingleP2SHDeposit)
    )
    fundingTx = bitcoinTestData.deposits[0].fundingTx
    depositRevealInfo = bitcoinTestData.deposits[0].reveal
    depositRevealInfo.vault = tbtcVault.address

    // Set the deposit dust threshold to 0.0001 BTC, i.e. 100x smaller than
    // the initial value in the Bridge; we had to save test Bitcoins when
    // generating test data.
    await bridge.setDepositDustThreshold(10000)
    // Disable the reveal ahead period since refund locktimes are fixed
    // within transactions used in this test suite.
    await bridge.setDepositRevealAheadPeriod(0)

    // Set up test data needed to submit deposit sweep proof via
    // bridge.submitDepositSweepProof(sweepTx, sweepProof, mainUtxo)
    chainDifficulty = bitcoinTestData.chainDifficulty
    sweepTx = bitcoinTestData.sweepTx
    sweepProof = bitcoinTestData.sweepProof
    mainUtxo = bitcoinTestData.mainUtxo
    relay.getPrevEpochDifficulty.returns(chainDifficulty)
    relay.getCurrentEpochDifficulty.returns(chainDifficulty)

    // Set up test data needed to request optimistic minting via
    // tbtcVault.optimisticMint(fundingTxHash, fundingOutputIndex)
    fundingTxHash = fundingTx.hash
    fundingOutputIndex = depositRevealInfo.fundingOutputIndex

    // Calculate the key of revealed deposit. This value is used in tests so we
    // calculate it once, in the setup.
    depositKey = ethers.utils.solidityKeccak256(
      ["bytes32", "uint32"],
      [fundingTxHash, fundingOutputIndex]
    )

    // Use the BridgeStubs' test utility functions to register a wallet. We do
    // not want to execute the entire DKG in the setup for this test.
    const { walletPubKeyHash } = depositRevealInfo
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
    await bridge.setWalletMainUtxo(walletPubKeyHash, mainUtxo)
  })

  describe("addMinter", () => {
    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault.connect(minter).addMinter(minter.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when address is not a minter", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await tbtcVault.connect(governance).addMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add address as a minter", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await tbtcVault.isMinter(minter.address)).to.be.true
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "MinterAdded")
            .withArgs(minter.address)
        })
      })

      context("when address is a minter", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.connect(governance).addMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault.connect(governance).addMinter(minter.address)
          ).to.be.revertedWith("This address is already a minter")
        })
      })
    })
  })

  describe("removeMinter", () => {
    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault.connect(thirdParty).removeMinter(minter.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when address is a minter", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcVault.connect(governance).addMinter(minter.address)
          tx = await tbtcVault.connect(governance).removeMinter(minter.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should take minter role from the address", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await tbtcVault.isMinter(minter.address)).to.be.false
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "MinterRemoved")
            .withArgs(minter.address)
        })
      })

      context("when address is not a minter", () => {
        it("should revert", async () => {
          await expect(
            tbtcVault.connect(governance).removeMinter(thirdParty.address)
          ).to.be.revertedWith("This address is not a minter")
        })
      })
    })
  })

  describe("addGuard", () => {
    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault.connect(guard).addGuard(guard.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when address is not a guard", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          tx = await tbtcVault.connect(governance).addGuard(guard.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should add address as a guard", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await tbtcVault.isGuard(guard.address)).to.be.true
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "GuardAdded")
            .withArgs(guard.address)
        })
      })

      context("when address is a guard", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.connect(governance).addGuard(guard.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault.connect(governance).addGuard(guard.address)
          ).to.be.revertedWith("This address is already a guard")
        })
      })
    })
  })

  describe("removeGuard", () => {
    context("when called not by the governance", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault.connect(thirdParty).removeGuard(guard.address)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })
    })

    context("when called by the governance", () => {
      context("when address is a guard", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcVault.connect(governance).addGuard(guard.address)
          tx = await tbtcVault.connect(governance).removeGuard(guard.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should take guard role from the address", async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          expect(await tbtcVault.isGuard(guard.address)).to.be.false
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "GuardRemoved")
            .withArgs(guard.address)
        })
      })

      context("when address is not a guard", () => {
        it("should revert", async () => {
          await expect(
            tbtcVault.connect(governance).removeGuard(guard.address)
          ).to.be.revertedWith("This address is not a guard")
        })
      })
    })
  })

  describe("optimisticMint", () => {
    context("when called not by a minter", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(thirdParty)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
        ).to.be.revertedWith("Caller is not a minter")
      })
    })

    context("when called by a minter", () => {
      before(async () => {
        await createSnapshot()
        await tbtcVault.connect(governance).addMinter(minter.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the deposit has not been revealed", () => {
        it("should revert", async () => {
          await expect(
            tbtcVault.connect(minter).optimisticMint(fundingTxHash, 10)
          ).to.be.revertedWith("The deposit has not been revealed")
        })
      })

      context("when the deposit has been revealed", () => {
        context("when the deposit has been swept", () => {
          before(async () => {
            await createSnapshot()

            await bridge.revealDeposit(fundingTx, depositRevealInfo)

            await bridge
              .connect(spvMaintainer)
              .submitDepositSweepProof(
                sweepTx,
                sweepProof,
                mainUtxo,
                tbtcVault.address
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              tbtcVault
                .connect(minter)
                .optimisticMint(fundingTxHash, fundingOutputIndex)
            ).to.be.revertedWith("The deposit is already swept")
          })
        })

        context("when the deposit is targeted to another vault", () => {
          before(async () => {
            await createSnapshot()

            const anotherVault = "0x42B2bCa0377cEF0027BF308f2a84343D44338Bd9"

            await bridgeGovernance
              .connect(governance)
              .setVaultStatus(anotherVault, true)

            const revealToAnotherVault = JSON.parse(
              JSON.stringify(depositRevealInfo)
            )
            revealToAnotherVault.vault = anotherVault

            await bridge.revealDeposit(fundingTx, revealToAnotherVault)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              tbtcVault
                .connect(minter)
                .optimisticMint(fundingTxHash, fundingOutputIndex)
            ).to.be.revertedWith("Unexpected vault address")
          })
        })

        context("when all conditions are met", () => {
          let tx: ContractTransaction

          before(async () => {
            await createSnapshot()

            await bridge.revealDeposit(fundingTx, depositRevealInfo)
            tx = await tbtcVault
              .connect(minter)
              .optimisticMint(fundingTxHash, fundingOutputIndex)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should register pending optimistic mint", async () => {
            expect(
              await tbtcVault.pendingOptimisticMints(depositKey)
            ).to.be.equal(await lastBlockTime())
          })

          it("should emit an event", async () => {
            await expect(tx)
              .to.emit(tbtcVault, "OptimisticMintingRequested")
              .withArgs(
                minter.address,
                fundingTxHash,
                fundingOutputIndex,
                depositKey
              )
          })
        })
      })
    })
  })

  describe("finalizeOptimisticMint", () => {
    context("when called not by a minter", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(thirdParty)
            .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
        ).to.be.revertedWith("Caller is not a minter")
      })
    })

    context("when called by a minter", () => {
      before(async () => {
        await createSnapshot()
        await tbtcVault.connect(governance).addMinter(minter.address)

        await bridge.revealDeposit(fundingTx, depositRevealInfo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when minting has not been requested", () => {
        it("should revert", async () => {
          await expect(
            tbtcVault
              .connect(minter)
              .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith(
            "Optimistic minting not requested or already finalized"
          )
        })
      })

      context("when the minting delay has not passed yet", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
          await increaseTime(
            (await tbtcVault.OPTIMISTIC_MINTING_DELAY()).sub(1)
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault
              .connect(minter)
              .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith("Optimistic minting delay has not passed yet")
        })
      })

      context("when requested minting has been already finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
          await increaseTime(await tbtcVault.OPTIMISTIC_MINTING_DELAY())
          await tbtcVault
            .connect(minter)
            .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault
              .connect(minter)
              .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith(
            "Optimistic minting not requested or already finalized"
          )
        })
      })

      context("when the deposit has been already swept", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
          await increaseTime(await tbtcVault.OPTIMISTIC_MINTING_DELAY())

          await bridge
            .connect(spvMaintainer)
            .submitDepositSweepProof(
              sweepTx,
              sweepProof,
              mainUtxo,
              tbtcVault.address
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault
              .connect(minter)
              .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith("The deposit is already swept")
        })
      })

      context("when all conditions are met", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
          await increaseTime(await tbtcVault.OPTIMISTIC_MINTING_DELAY())

          tx = await tbtcVault
            .connect(minter)
            .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should mint TBTC", async () => {
          // TODO: The output value is 0.0002 BTC. We should take into account
          // fees in the contract
          // See https://live.blockcypher.com/btc-testnet/tx/c580e0e352570d90e303d912a506055ceeb0ee06f97dce6988c69941374f5479/
          expect(await tbtc.balanceOf(depositRevealInfo.depositor)).to.be.equal(
            20000
          )
        })

        it("should incur optimistic mint debt", async () => {
          expect(
            await tbtcVault.optimisticMintingDebt(depositRevealInfo.depositor)
          ).to.be.equal(20000)
        })

        it("should remove the request", async () => {
          expect(await tbtcVault.pendingOptimisticMints(depositKey)).to.equal(0)
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "OptimisticMintingFinalized")
            .withArgs(
              minter.address,
              fundingTxHash,
              fundingOutputIndex,
              depositKey
            )
        })
      })
    })
  })

  describe("cancelOptimisticMint", () => {
    context("when called not by a guard", () => {
      it("should revert", async () => {
        await expect(
          tbtcVault
            .connect(thirdParty)
            .cancelOptimisticMint(fundingTxHash, fundingOutputIndex)
        ).to.be.revertedWith("Caller is not a guard")
      })
    })

    context("when called by a guard", () => {
      before(async () => {
        await createSnapshot()
        await tbtcVault.connect(governance).addMinter(minter.address)
        await tbtcVault.connect(governance).addGuard(guard.address)

        await bridge.revealDeposit(fundingTx, depositRevealInfo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when minting has not been requested", () => {
        it("should revert", async () => {
          await expect(
            tbtcVault.connect(guard).cancelOptimisticMint(fundingTxHash, 99)
          ).to.be.revertedWith(
            "Optimistic minting not requested of already finalized"
          )
        })
      })

      context("when requested minting has been finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)
          await increaseTime(await tbtcVault.OPTIMISTIC_MINTING_DELAY())
          await tbtcVault
            .connect(minter)
            .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            tbtcVault
              .connect(guard)
              .cancelOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith(
            "Optimistic minting not requested of already finalized"
          )
        })
      })

      context("when requested minting has not been finalized", () => {
        let tx: ContractTransaction

        before(async () => {
          await createSnapshot()

          await tbtcVault
            .connect(minter)
            .optimisticMint(fundingTxHash, fundingOutputIndex)

          tx = await tbtcVault
            .connect(guard)
            .cancelOptimisticMint(fundingTxHash, fundingOutputIndex)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should cancel optimistic minting", async () => {
          expect(
            await tbtcVault.pendingOptimisticMints(depositKey)
          ).to.be.equal(0)

          await increaseTime(await tbtcVault.OPTIMISTIC_MINTING_DELAY())
          await expect(
            tbtcVault
              .connect(minter)
              .finalizeOptimisticMint(fundingTxHash, fundingOutputIndex)
          ).to.be.revertedWith(
            "Optimistic minting not requested or already finalized"
          )
        })

        it("should emit an event", async () => {
          await expect(tx)
            .to.emit(tbtcVault, "OptimisticMintingCancelled")
            .withArgs(
              guard.address,
              fundingTxHash,
              fundingOutputIndex,
              depositKey
            )
        })
      })
    })
  })
})
