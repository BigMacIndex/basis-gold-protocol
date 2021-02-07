import chai, { expect } from 'chai';
import { ethers } from 'hardhat';
import { solidity } from 'ethereum-waffle';
import {
  Contract,
  ContractFactory,
  BigNumber,
  utils,
  BigNumberish,
} from 'ethers';
import { Provider } from '@ethersproject/providers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { advanceTimeAndBlock } from './shared/utilities';

chai.use(solidity);

const DAY = 86400;
const ETH = utils.parseEther('1');
const BIGMACINDEX_PRICE_ONE = utils.parseEther('1850');
const ZERO = BigNumber.from(0);
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const INITIAL_BMI_AMOUNT = utils.parseEther('50');
const INITIAL_BMB_AMOUNT = utils.parseEther('10000');
const INITIAL_BMS_AMOUNT = utils.parseEther('50000');

async function latestBlocktime(provider: Provider): Promise<number> {
  const { timestamp } = await provider.getBlock('latest');
  return timestamp;
}

function bigmin(a: BigNumber, b: BigNumber): BigNumber {
  return a.lt(b) ? a : b;
}

describe('Treasury', () => {
  const { provider } = ethers;

  let operator: SignerWithAddress;
  let ant: SignerWithAddress;

  before('provider & accounts setting', async () => {
    [operator, ant] = await ethers.getSigners();
  });

  // core
  let Bond: ContractFactory;
  let BigMacIndex: ContractFactory;
  let Share: ContractFactory;
  let Treasury: ContractFactory;
  let SimpleFund: ContractFactory;
  let MockOracle: ContractFactory;
  let MockBoardroom: ContractFactory;

  before('fetch contract factories', async () => {
    Bond = await ethers.getContractFactory('Bond');
    BigMacIndex = await ethers.getContractFactory('BigMacIndex');
    Share = await ethers.getContractFactory('Share');
    Treasury = await ethers.getContractFactory('Treasury');
    SimpleFund = await ethers.getContractFactory('SimpleERCFund');
    MockOracle = await ethers.getContractFactory('MockOracle');
    MockBoardroom = await ethers.getContractFactory('MockBoardroom');
  });

  let bond: Contract;
  let bigMacIndex: Contract;
  let share: Contract;
  let oracle: Contract;
  let treasury: Contract;
  let boardroom: Contract;
  let fund: Contract;

  let startTime: BigNumber;

  beforeEach('deploy contracts', async () => {
    bigMacIndex = await BigMacIndex.connect(operator).deploy();
    bond = await Bond.connect(operator).deploy();
    share = await Share.connect(operator).deploy();
    oracle = await MockOracle.connect(operator).deploy();
    boardroom = await MockBoardroom.connect(operator).deploy(bigMacIndex.address);
    fund = await SimpleFund.connect(operator).deploy();

    startTime = BigNumber.from(await latestBlocktime(provider)).add(DAY);
    treasury = await Treasury.connect(operator).deploy(
      bigMacIndex.address,
      bond.address,
      share.address,
      oracle.address,
      boardroom.address,
      fund.address,
      startTime
    );
    await fund.connect(operator).transferOperator(treasury.address);
  });

  describe('governance', () => {
    let newTreasury: Contract;

    beforeEach('deploy new treasury', async () => {
      newTreasury = await Treasury.connect(operator).deploy(
        bigMacIndex.address,
        bond.address,
        share.address,
        oracle.address,
        boardroom.address,
        fund.address,
        await latestBlocktime(provider)
      );

      for await (const token of [bigMacIndex, bond, share]) {
        await token.connect(operator).mint(treasury.address, ETH);
        await token.connect(operator).transferOperator(treasury.address);
        await token.connect(operator).transferOwnership(treasury.address);
      }
      await boardroom.connect(operator).transferOperator(treasury.address);
    });

    describe('#initialize', () => {
      it('should works correctly', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await expect(newTreasury.initialize())
          .to.emit(newTreasury, 'Initialized')
          .to.emit(bigMacIndex, 'Transfer')
          .withArgs(newTreasury.address, ZERO_ADDR, ETH)
          .to.emit(bigMacIndex, 'Transfer');

        expect(await newTreasury.getReserve()).to.eq(ZERO);
      });

      it('should fail if newTreasury is not the operator of core contracts', async () => {
        await boardroom.connect(operator).transferOperator(ant.address);
        await expect(newTreasury.initialize()).to.revertedWith(
          'Treasury: need more permission'
        );
      });

      it('should fail if abuser tries to initialize twice', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await newTreasury.initialize();
        await expect(newTreasury.initialize()).to.revertedWith(
          'Treasury: initialized'
        );
      });
    });

    describe('#migrate', () => {
      it('should works correctly', async () => {
        await expect(treasury.connect(operator).migrate(newTreasury.address))
          .to.emit(treasury, 'Migration')
          .withArgs(newTreasury.address);

        for await (const token of [bigMacIndex, bond, share]) {
          expect(await token.balanceOf(newTreasury.address)).to.eq(ETH);
          expect(await token.owner()).to.eq(newTreasury.address);
          expect(await token.operator()).to.eq(newTreasury.address);
        }
      });

      it('should fail if treasury is not the operator of core contracts', async () => {
        await boardroom.connect(operator).transferOperator(ant.address);
        await expect(
          treasury.connect(operator).migrate(newTreasury.address)
        ).to.revertedWith('Treasury: need more permission');
      });

      it('should fail if already migrated', async () => {
        await treasury.connect(operator).migrate(newTreasury.address);
        await boardroom.connect(operator).transferOperator(newTreasury.address);

        await newTreasury.connect(operator).migrate(treasury.address);
        await boardroom.connect(operator).transferOperator(treasury.address);

        await expect(
          treasury.connect(operator).migrate(newTreasury.address)
        ).to.revertedWith('Treasury: migrated');
      });
    });
  });

  describe('seigniorage', () => {
    describe('#allocateSeigniorage', () => {
      beforeEach('transfer permissions', async () => {
        await bond.mint(operator.address, INITIAL_BMB_AMOUNT);
        await bigMacIndex.mint(operator.address, INITIAL_BMS_AMOUNT);
        await bigMacIndex.mint(treasury.address, INITIAL_BMI_AMOUNT);
        await share.mint(operator.address, INITIAL_BMS_AMOUNT);
        for await (const contract of [bigMacIndex, bond, share, boardroom]) {
          await contract.connect(operator).transferOperator(treasury.address);
        }
      });

      describe('after migration', () => {
        it('should fail if contract migrated', async () => {
          for await (const contract of [bigMacIndex, bond, share]) {
            await contract
              .connect(operator)
              .transferOwnership(treasury.address);
          }

          await treasury.connect(operator).migrate(operator.address);
          expect(await treasury.migrated()).to.be.true;

          await expect(treasury.allocateSeigniorage()).to.revertedWith(
            'Treasury: migrated'
          );
        });
      });

      describe('before startTime', () => {
        it('should fail if not started yet', async () => {
          await expect(treasury.allocateSeigniorage()).to.revertedWith(
            'Epoch: not started yet'
          );
        });
      });

      describe('after startTime', () => {
        beforeEach('advance blocktime', async () => {
          // wait til first epoch
          await advanceTimeAndBlock(
            provider,
            startTime.sub(await latestBlocktime(provider)).toNumber()
          );
        });

        it('should funded correctly', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(210).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          // calculate with circulating supply
          const treasuryHoldings = await treasury.getReserve();
          const bigMacIndexSupply = (await bigMacIndex.totalSupply()).sub(treasuryHoldings);
          const ratio = bigMacIndexPrice.mul(String(1e18)).div(BIGMACINDEX_PRICE_ONE).sub(String(1e18))
          const expectedSeigniorage = (bigMacIndexSupply.mul(ratio)).div(String(1e18));

          // get all expected reserve
          const expectedFundReserve = expectedSeigniorage
            .mul(await treasury.fundAllocationRate())
            .div(100);

          const expectedTreasuryReserve = bigmin(
            expectedSeigniorage.sub(expectedFundReserve),
            (await bond.totalSupply()).sub(treasuryHoldings)
          );

          const expectedBoardroomReserve = expectedSeigniorage
            .sub(expectedFundReserve)
            .sub(expectedTreasuryReserve);

          const allocationResult = await treasury.allocateSeigniorage();

          if (expectedFundReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'ContributionPoolFunded')
              .withArgs(await latestBlocktime(provider), expectedFundReserve);
          }

          if (expectedTreasuryReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'TreasuryFunded')
              .withArgs(
                await latestBlocktime(provider),
                expectedTreasuryReserve
              );
          }

          if (expectedBoardroomReserve.gt(ZERO)) {
            await expect(new Promise((resolve) => resolve(allocationResult)))
              .to.emit(treasury, 'BoardroomFunded')
              .withArgs(
                await latestBlocktime(provider),
                expectedBoardroomReserve
              );
          }

          expect(await bigMacIndex.balanceOf(fund.address)).to.eq(expectedFundReserve);
          expect(await treasury.getReserve()).to.eq(expectedTreasuryReserve);
          expect(await bigMacIndex.balanceOf(boardroom.address)).to.eq(
            expectedBoardroomReserve
          );
        });

        it('should funded even fails to call update function in oracle', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setRevert(true);
          await oracle.setPrice(bigMacIndexPrice);

          await expect(treasury.allocateSeigniorage()).to.emit(
            treasury,
            'TreasuryFunded'
          );
        });

        it('should move to next epoch after allocation', async () => {
          const bigMacIndexPrice1 = ETH.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice1);

          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(0));
          expect(await treasury.nextEpochPoint()).to.eq(startTime);

          await treasury.allocateSeigniorage();
          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(1));
          expect(await treasury.nextEpochPoint()).to.eq(startTime.add(DAY));

          await advanceTimeAndBlock(
            provider,
            Number(await treasury.nextEpochPoint()) -
              (await latestBlocktime(provider))
          );

          const bigMacIndexPrice2 = ETH.mul(104).div(100);
          await oracle.setPrice(bigMacIndexPrice2);

          await treasury.allocateSeigniorage();
          expect(await treasury.getCurrentEpoch()).to.eq(BigNumber.from(2));
          expect(await treasury.nextEpochPoint()).to.eq(startTime.add(DAY * 2));
        });

        describe('should fail', () => {
          it('if treasury is not the operator of core contract', async () => {
            const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
            await oracle.setPrice(bigMacIndexPrice);

            for await (const target of [bigMacIndex, bond, share, boardroom]) {
              await target.connect(operator).transferOperator(ant.address);
              await expect(treasury.allocateSeigniorage()).to.revertedWith(
                'Treasury: need more permission'
              );
            }
          });

          it('if seigniorage already allocated in this epoch', async () => {
            const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
            await oracle.setPrice(bigMacIndexPrice);
            await treasury.allocateSeigniorage();
            await expect(treasury.allocateSeigniorage()).to.revertedWith(
              'Epoch: not allowed'
            );
          });
        });
      });
    });
  });

  describe('bonds', async () => {
    beforeEach('transfer permissions', async () => {
      await bigMacIndex.mint(operator.address, INITIAL_BSG_AMOUNT);
      await bond.mint(operator.address, INITIAL_BSGB_AMOUNT);
      for await (const contract of [bigMacIndex, bond, share, boardroom]) {
        await contract.connect(operator).transferOperator(treasury.address);
      }
    });

    describe('after migration', () => {
      it('should fail if contract migrated', async () => {
        for await (const contract of [bigMacIndex, bond, share]) {
          await contract.connect(operator).transferOwnership(treasury.address);
        }

        await treasury.connect(operator).migrate(operator.address);
        expect(await treasury.migrated()).to.be.true;

        await expect(treasury.buyBonds(ETH, ETH)).to.revertedWith(
          'Treasury: migrated'
        );
        await expect(treasury.redeemBonds(ETH, ETH)).to.revertedWith(
          'Treasury: migrated'
        );
      });
    });

    describe('before startTime', () => {
      it('should fail if not started yet', async () => {
        await expect(treasury.buyBonds(ETH, ETH)).to.revertedWith(
          'Epoch: not started yet'
        );
        await expect(treasury.redeemBonds(ETH, ETH)).to.revertedWith(
          'Epoch: not started yet'
        );
      });
    });

    describe('after startTime', () => {
      beforeEach('advance blocktime', async () => {
        // wait til first epoch
        await advanceTimeAndBlock(
          provider,
          startTime.sub(await latestBlocktime(provider)).toNumber()
        );
      });

      describe('#buyBonds', () => {
        it('should work if bigMacIndex price below realbigMacIndexPrice', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(90).div(100); // bigMacIndex_PRICE_ONE * 0.9
          const bigMacIndexPriceRatio = bigMacIndexPrice.mul(ETH).div(BIGMACINDEX_PRICE_ONE);
          await oracle.setPrice(bigMacIndexPrice);
          await bigMacIndex.connect(operator).transfer(ant.address, ETH);
          await bigMacIndex.connect(ant).approve(treasury.address, ETH);

          await expect(treasury.connect(ant).buyBonds(ETH, bigMacIndexPrice))
            .to.emit(treasury, 'BoughtBonds')
            .withArgs(ant.address, ETH);

          expect(await bigMacIndex.balanceOf(ant.address)).to.eq(ZERO);
          expect(await bond.balanceOf(ant.address)).to.eq(
            ETH.mul(ETH).div(bigMacIndexPriceRatio)
          );
        });

        it('should fail if bigMacIndex price over realbigMacIndexPrice', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(101).div(100); // realbigMacIndexPrice * 1.01
          await oracle.setPrice(bigMacIndexPrice);
          await bigMacIndex.connect(operator).transfer(ant.address, ETH);
          await bigMacIndex.connect(ant).approve(treasury.address, ETH);

          await expect(
            treasury.connect(ant).buyBonds(ETH, bigMacIndexPrice)
          ).to.revertedWith(
            'Treasury: bigMacIndexPrice not eligible for bond purchase'
          );
        });

        it('should fail if price changed', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(99).div(100); // $0.99
          await oracle.setPrice(bigMacIndexPrice);
          await bigMacIndex.connect(operator).transfer(ant.address, ETH);
          await bigMacIndex.connect(ant).approve(treasury.address, ETH);

          await expect(
            treasury.connect(ant).buyBonds(ETH, ETH)
          ).to.revertedWith('Treasury: bigMacIndex price moved');
        });

        it('should fail if purchase bonds with zero amount', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(99).div(100); // $0.99
          await oracle.setPrice(bigMacIndexPrice);

          await expect(
            treasury.connect(ant).buyBonds(ZERO, bigMacIndexPrice)
          ).to.revertedWith('Treasury: cannot purchase bonds with zero amount');
        });
      });
      describe('#redeemBonds', () => {
        beforeEach('allocate seigniorage to treasury', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);
          await treasury.allocateSeigniorage();
          await advanceTimeAndBlock(
            provider,
            Number(await treasury.nextEpochPoint()) -
              (await latestBlocktime(provider))
          );
        });

        it('should work if bigMacIndex price exceeds realbigMacIndexPrice * 1.05', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(treasury.connect(ant).redeemBonds(ETH, bigMacIndexPrice))
            .to.emit(treasury, 'RedeemedBonds')
            .withArgs(ant.address, ETH);

          expect(await bond.balanceOf(ant.address)).to.eq(ZERO); // 1:1
          expect(await bigMacIndex.balanceOf(ant.address)).to.eq(ETH);
        });

        it("should drain over seigniorage and even contract's budget", async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          await bigMacIndex.connect(operator).transfer(treasury.address, ETH); // $1002

          const treasuryBalance = await bigMacIndex.balanceOf(treasury.address);
          await bond.connect(operator).transfer(ant.address, treasuryBalance);
          await bond.connect(ant).approve(treasury.address, treasuryBalance);
          await treasury.connect(ant).redeemBonds(treasuryBalance, bigMacIndexPrice);

          expect(await bond.balanceOf(ant.address)).to.eq(ZERO);
          expect(await bigMacIndex.balanceOf(ant.address)).to.eq(treasuryBalance); // 1:1
        });

        it('should fail if price changed', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(
            treasury.connect(ant).redeemBonds(ETH, ETH)
          ).to.revertedWith('Treasury: bigMacIndex price moved');
        });

        it('should fail if redeem bonds with zero amount', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          await expect(
            treasury.connect(ant).redeemBonds(ZERO, bigMacIndexPrice)
          ).to.revertedWith('Treasury: cannot redeem bonds with zero amount');
        });

        it('should fail if bigMacIndex price is below realbigMacIndexPrice+ε', async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(104).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          await bond.connect(operator).transfer(ant.address, ETH);
          await bond.connect(ant).approve(treasury.address, ETH);
          await expect(
            treasury.connect(ant).redeemBonds(ETH, bigMacIndexPrice)
          ).to.revertedWith(
            'Treasury: bigMacIndexPrice not eligible for bond purchase'
          );
        });

        it("should fail if redeem bonds over contract's budget", async () => {
          const bigMacIndexPrice = BIGMACINDEX_PRICE_ONE.mul(106).div(100);
          await oracle.setPrice(bigMacIndexPrice);

          const treasuryBalance = await bigMacIndex.balanceOf(treasury.address);
          const redeemAmount = treasuryBalance.add(ETH);
          await bond.connect(operator).transfer(ant.address, redeemAmount);
          await bond.connect(ant).approve(treasury.address, redeemAmount);

          await expect(
            treasury.connect(ant).redeemBonds(redeemAmount, bigMacIndexPrice)
          ).to.revertedWith('Treasury: treasury has no more budget');
        });
      });
    });
  });
});
