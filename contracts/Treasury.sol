pragma solidity ^0.6.0;

import '@openzeppelin/contracts/math/Math.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/SafeERC20.sol';
import '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

import './interfaces/IOracle.sol';
import './interfaces/IBoardroom.sol';
import './interfaces/IBasisAsset.sol';
import './interfaces/ISimpleERCFund.sol';
import './lib/Babylonian.sol';
import './lib/FixedPoint.sol';
import './lib/Safe112.sol';
import './owner/Operator.sol';
import './utils/Epoch.sol';
import './utils/ContractGuard.sol';
import './ChainLinkOracle.sol';

/**
 * @title Big Mac Index Treasury contract
 * @notice Monetary policy logic to adjust supplies of Big Mac Index assets
 * @author Summer Smith & Rick Sanchez
 */
contract Treasury is ContractGuard, Epoch {
    using FixedPoint for *;
    using SafeERC20 for IERC20;
    using Address for address;
    using SafeMath for uint256;
    using Safe112 for uint112;

    /* ========== STATE VARIABLES ========== */

    // ========== FLAGS
    bool public migrated = false;
    bool public initialized = false;

    // ========== CORE
    address public fund;
    address public macIndex;
    address public bond;
    address public share;
    address public boardroom;

    IOracle public macIndexOracle;
    ChainlinkOracle public tmcOracle; //total market cap oracle

    // ========== PARAMS
    uint256 private accumulatedSeigniorage = 0;
    uint256 public fundAllocationRate = 2; // %

    /* ========== CONSTRUCTOR ========== */

    constructor(
        address _macIndex,
        address _bond,
        address _share,
        IOracle _macIndexOracle,
        ChainlinkOracle _tmcOracle,
        address _boardroom,
        address _fund,
        uint256 _startTime
    ) public Epoch(8 hours, _startTime, 0) {
        macIndex = _macIndex;
        bond = _bond;
        share = _share;
        macIndexOracle = _macIndexOracle;
        tmcOracle = _tmcOracle;
        boardroom = _boardroom;
        fund = _fund;
    }

    /* =================== Modifier =================== */

    modifier checkMigration {
        require(!migrated, 'Treasury: migrated');

        _;
    }

    modifier checkOperator {
        require(
            IBasisAsset(macIndex).operator() == address(this) &&
                IBasisAsset(bond).operator() == address(this) &&
                IBasisAsset(share).operator() == address(this) &&
                Operator(boardroom).operator() == address(this),
            'Treasury: need more permission'
        );

        _;
    }

    /* ========== Oracle FUNCTIONS ========== */


    function getOraclePrice(ChainlinkOracle _oracle)
        public
        virtual
        view
        returns (uint256 price)
    {
        price = _oracle.getLatestAnswer().toUint256().mul(oracleDigits);
    }

    /* ========== VIEW FUNCTIONS ========== */

    // budget
    function getReserve() public view returns (uint256) {
        return accumulatedSeigniorage;
    }

    function getMacIndexPrice() public view returns (uint256) {
        try macIndexOracle.price1Last() returns (uint256 price) {
            return price;
        } catch {
            revert('Treasury: failed to consult macIndex price from the oracle');
        }
    }

    /**
    * @notice Returns the target price of the MCI token
    * @return target price of the MCI Token
    * @dev MCI token is 18 decimals
    * @dev oracle getTotalMarketCap must be in wei format
    * @dev P = M / d
    * P = Target MCI Token Price
    * M = Total Crypto Market Cap
    * d = Divisor
    */
    function getTargetPrice() public virtual view returns (uint256 targetPrice) {
        uint256 totalMarketPrice = getOraclePrice(tmcOracle);
        targetPrice = totalMarketPrice.div(10**12);
    }

    function macIndexPriceCeiling() public view returns(uint256) {
        return getTargetPrice().mul(uint256(105)).div(100);
    }

    


    /* ========== GOVERNANCE ========== */

    function initialize() public checkOperator {
        require(!initialized, 'Treasury: initialized');

        // burn all of it's balance
        IBasisAsset(macIndex).burn(IERC20(macIndex).balanceOf(address(this)));

        // set accumulatedSeigniorage to it's balance
        accumulatedSeigniorage = IERC20(macIndex).balanceOf(address(this));

        initialized = true;
        emit Initialized(msg.sender, block.number);
    }

    function migrate(address target) public onlyOperator checkOperator {
        require(!migrated, 'Treasury: migrated');

        // macIndex
        Operator(macIndex).transferOperator(target);
        Operator(macIndex).transferOwnership(target);
        IERC20(macIndex).transfer(target, IERC20(macIndex).balanceOf(address(this)));

        // bond
        Operator(bond).transferOperator(target);
        Operator(bond).transferOwnership(target);
        IERC20(bond).transfer(target, IERC20(bond).balanceOf(address(this)));

        // share
        Operator(share).transferOperator(target);
        Operator(share).transferOwnership(target);
        IERC20(share).transfer(target, IERC20(share).balanceOf(address(this)));

        migrated = true;
        emit Migration(target);
    }

    function setFund(address newFund) public onlyOperator {
        fund = newFund;
        emit ContributionPoolChanged(msg.sender, newFund);
    }

    function setFundAllocationRate(uint256 rate) public onlyOperator {
        fundAllocationRate = rate;
        emit ContributionPoolRateChanged(msg.sender, rate);
    }

    /* ========== MUTABLE FUNCTIONS ========== */

    function _updatemacIndexPrice() internal {
        try macIndexOracle.update() {} catch {}
    }

    function buyBonds(uint256 amount, uint256 desiredPurchasePrice)
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkOperator
    {
        require(amount > 0, 'Treasury: cannot purchase bonds with zero amount');

        uint256 macIndexPrice = getMacIndexPrice();
        uint256 targetPrice = getTargetPrice();

        require(macIndexPrice == desiredPurchasePrice, 'Treasury: macIndex price moved');
        require(
            macIndexPrice < targetPrice,
            'Treasury: macIndexPrice not eligible for bond purchase'
        );

        uint256 priceRatio = macIndexPrice.mul(1e18).div(getTargetPrice());
        IBasisAsset(macIndex).burnFrom(msg.sender, amount);
        IBasisAsset(bond).mint(msg.sender, amount.mul(1e18).div(priceRatio));
        _updatemacIndexPrice();

        emit BoughtBonds(msg.sender, amount);
    }

    function redeemBonds(uint256 amount, uint256 desiredPurchasePrice)
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkOperator
    {
        require(amount > 0, 'Treasury: cannot redeem bonds with zero amount');

        uint256 macIndexPrice = getMacIndexPrice();
        require(macIndexPrice == targetPrice, 'Treasury: macIndex price moved');
        require(
            macIndexPrice > macIndexPriceCeiling(), // price > realmacIndexPrice * 1.05
            'Treasury: macIndexPrice not eligible for bond purchase'
        );
        require(
            IERC20(macIndex).balanceOf(address(this)) >= amount,
            'Treasury: treasury has no more budget'
        );

        accumulatedSeigniorage = accumulatedSeigniorage.sub(
            Math.min(accumulatedSeigniorage, amount)
        );

        IBasisAsset(bond).burnFrom(msg.sender, amount);
        IERC20(macIndex).safeTransfer(msg.sender, amount);
        _updatemacIndexPrice();

        emit RedeemedBonds(msg.sender, amount);
    }

    function allocateSeigniorage()
        external
        onlyOneBlock
        checkMigration
        checkStartTime
        checkEpoch
        checkOperator
    {
        _updatemacIndexPrice();
        uint256 macIndexPrice = getMacIndexPrice();
        if (macIndexPrice <= macIndexPriceCeiling()) {
            return; // just advance epoch instead revert
        }

        // circulating supply
        uint256 macIndexSupply = IERC20(macIndex).totalSupply().sub(
            accumulatedSeigniorage
        );
        uint256 percentage = (macIndexPrice.mul(1e18).div(getTargetPrice())).sub(1e18);
        uint256 seigniorage = macIndexSupply.mul(percentage).div(1e18);
        IBasisAsset(macIndex).mint(address(this), seigniorage);

        // ======================== BIP-3
        uint256 fundReserve = seigniorage.mul(fundAllocationRate).div(100);
        if (fundReserve > 0) {
            IERC20(macIndex).safeApprove(fund, fundReserve);
            ISimpleERCFund(fund).deposit(
                macIndex,
                fundReserve,
                'Treasury: Seigniorage Allocation'
            );
            emit ContributionPoolFunded(now, fundReserve);
        }

        seigniorage = seigniorage.sub(fundReserve);

        // ======================== BIP-4
        uint256 treasuryReserve = Math.min(
            seigniorage,
            IERC20(bond).totalSupply().sub(accumulatedSeigniorage)
        );
        if (treasuryReserve > 0) {
            accumulatedSeigniorage = accumulatedSeigniorage.add(
                treasuryReserve
            );
            emit TreasuryFunded(now, treasuryReserve);
        }

        // boardroom
        uint256 boardroomReserve = seigniorage.sub(treasuryReserve);
        if (boardroomReserve > 0) {
            IERC20(macIndex).safeApprove(boardroom, boardroomReserve);
            IBoardroom(boardroom).allocateSeigniorage(boardroomReserve);
            emit BoardroomFunded(now, boardroomReserve);
        }
    }

    // GOV
    event Initialized(address indexed executor, uint256 at);
    event Migration(address indexed target);
    event ContributionPoolChanged(address indexed operator, address newFund);
    event ContributionPoolRateChanged(
        address indexed operator,
        uint256 newRate
    );

    // CORE
    event RedeemedBonds(address indexed from, uint256 amount);
    event BoughtBonds(address indexed from, uint256 amount);
    event TreasuryFunded(uint256 timestamp, uint256 seigniorage);
    event BoardroomFunded(uint256 timestamp, uint256 seigniorage);
    event ContributionPoolFunded(uint256 timestamp, uint256 seigniorage);
}
