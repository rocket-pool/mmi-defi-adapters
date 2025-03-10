import { SimplePoolAdapter } from '../../../../core/adapters/SimplePoolAdapter'
import { Chain } from '../../../../core/constants/chains'
import { SECONDS_PER_YEAR } from '../../../../core/constants/SECONDS_PER_YEAR'
import { ZERO_ADDRESS } from '../../../../core/constants/ZERO_ADDRESS'
import {
  IMetadataBuilder,
  CacheToFile,
} from '../../../../core/decorators/cacheToFile'
import { aprToApy } from '../../../../core/utils/aprToApy'
import { getTokenMetadata } from '../../../../core/utils/getTokenMetadata'
import { logger } from '../../../../core/utils/logger'
import {
  ProtocolDetails,
  PositionType,
  GetAprInput,
  GetApyInput,
  TokenBalance,
  ProtocolTokenApr,
  ProtocolTokenApy,
  UnderlyingTokenRate,
  Underlying,
  TokenType,
} from '../../../../types/adapter'
import { Erc20Metadata } from '../../../../types/erc20Metadata'
import {
  Converter__factory,
  Velocore__factory,
  Oracle__factory,
  Speed__factory,
  Cerc20__factory,
  Comptroller__factory,
} from '../../contracts'

type MendiFinanceSupplyAdapterMetadata = Record<
  string,
  {
    protocolToken: Erc20Metadata
    underlyingToken: Erc20Metadata
  }
>

const contractAddresses: Partial<
  Record<
    Chain,
    {
      comptroller: string
      speed: string
      oracle: string
      velocore: string
      converter: string
      mendi: string
      usdcE: string
    }
  >
> = {
  [Chain.Linea]: {
    comptroller: '0x1b4d3b0421dDc1eB216D230Bc01527422Fb93103',
    speed: '0x3b9B9364Bf69761d308145371c38D9b558013d40',
    oracle: '0xCcBea2d7e074744ab46e28a043F85038bCcfFec2',
    velocore: '0xaA18cDb16a4DD88a59f4c2f45b5c91d009549e06',
    converter: '0xAADAa473C1bDF7317ec07c915680Af29DeBfdCb5',
    mendi: '0x43E8809ea748EFf3204ee01F08872F063e44065f',
    usdcE: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff',
  },
}

export class MendiFinanceSupplyAdapter
  extends SimplePoolAdapter
  implements IMetadataBuilder
{
  productId = 'supply'

  getProtocolDetails(): ProtocolDetails {
    return {
      protocolId: this.protocolId,
      name: 'MendiFinance',
      description: 'MendiFinance borrow adapter',
      siteUrl: 'https://mendi.finance/:',
      iconUrl: 'https://mendi.finance/mendi-token.svg',
      positionType: PositionType.Supply,
      chainId: this.chainId,
      productId: this.productId,
    }
  }

  @CacheToFile({ fileKey: 'mendi' })
  async buildMetadata() {
    const comptrollerContract = Comptroller__factory.connect(
      contractAddresses[this.chainId]!.comptroller,
      this.provider,
    )

    const pools = await comptrollerContract.getAllMarkets()

    const metadataObject: MendiFinanceSupplyAdapterMetadata = {}

    await Promise.all(
      pools.map(async (poolContractAddress) => {
        const poolContract = Cerc20__factory.connect(
          poolContractAddress,
          this.provider,
        )

        let underlyingContractAddress: string
        try {
          underlyingContractAddress = await poolContract.underlying()
        } catch (error) {
          underlyingContractAddress = ZERO_ADDRESS
        }

        const protocolTokenPromise = getTokenMetadata(
          poolContractAddress,
          this.chainId,
          this.provider,
        )
        const underlyingTokenPromise = getTokenMetadata(
          underlyingContractAddress,
          this.chainId,
          this.provider,
        )

        const [protocolToken, underlyingToken] = await Promise.all([
          protocolTokenPromise,
          underlyingTokenPromise,
        ])

        metadataObject[poolContractAddress.toLowerCase()] = {
          protocolToken,
          underlyingToken,
        }
      }),
    )
    return metadataObject
  }

  async getProtocolTokens(): Promise<Erc20Metadata[]> {
    return Object.values(await this.buildMetadata()).map(
      ({ protocolToken }) => protocolToken,
    )
  }

  protected async getUnderlyingTokenBalances({
    userAddress,
    protocolTokenBalance,
    blockNumber,
  }: {
    userAddress: string
    protocolTokenBalance: TokenBalance
    blockNumber?: number
  }): Promise<Underlying[]> {
    const { underlyingToken } = await this.fetchPoolMetadata(
      protocolTokenBalance.address,
    )

    const poolContract = Cerc20__factory.connect(
      protocolTokenBalance.address,
      this.provider,
    )

    const underlyingBalance = await poolContract.balanceOfUnderlying.staticCall(
      userAddress,
      {
        blockTag: blockNumber,
      },
    )

    const underlyingTokenBalance = {
      ...underlyingToken,
      balanceRaw: underlyingBalance,
      type: TokenType.Underlying,
    }

    return [underlyingTokenBalance]
  }

  protected async fetchProtocolTokenMetadata(
    protocolTokenAddress: string,
  ): Promise<Erc20Metadata> {
    const { protocolToken } = await this.fetchPoolMetadata(protocolTokenAddress)

    return protocolToken
  }

  protected async getUnderlyingTokenConversionRate(
    protocolTokenMetadata: Erc20Metadata,
    blockNumber?: number | undefined,
  ): Promise<UnderlyingTokenRate[]> {
    const { underlyingToken } = await this.fetchPoolMetadata(
      protocolTokenMetadata.address,
    )

    const poolContract = Cerc20__factory.connect(
      protocolTokenMetadata.address,
      this.provider,
    )

    const exchangeRateCurrent =
      await poolContract.exchangeRateCurrent.staticCall({
        blockTag: blockNumber,
      })

    // The current exchange rate is scaled by 1 * 10^(18 - 8 + Underlying Token Decimals).
    const adjustedExchangeRate = exchangeRateCurrent / 10n ** 10n

    return [
      {
        ...underlyingToken,
        type: TokenType.Underlying,
        underlyingRateRaw: adjustedExchangeRate,
      },
    ]
  }

  async getApy({
    protocolTokenAddress,
    blockNumber,
  }: GetApyInput): Promise<ProtocolTokenApy> {
    const apy = await this.getProtocolTokenApy({
      protocolTokenAddress,
      blockNumber,
    })

    return {
      ...(await this.fetchProtocolTokenMetadata(protocolTokenAddress)),
      apyDecimal: apy * 100,
    }
  }

  async getApr({
    protocolTokenAddress,
    blockNumber,
  }: GetAprInput): Promise<ProtocolTokenApr> {
    const apr = await this.getProtocolTokenApr({
      protocolTokenAddress,
      blockNumber,
    })

    return {
      ...(await this.fetchProtocolTokenMetadata(protocolTokenAddress)),
      aprDecimal: apr * 100,
    }
  }

  protected async fetchUnderlyingTokensMetadata(
    protocolTokenAddress: string,
  ): Promise<Erc20Metadata[]> {
    const { underlyingToken } = await this.fetchPoolMetadata(
      protocolTokenAddress,
    )

    return [underlyingToken]
  }

  private async fetchPoolMetadata(protocolTokenAddress: string) {
    const poolMetadata = (await this.buildMetadata())[protocolTokenAddress]

    if (!poolMetadata) {
      logger.error({ protocolTokenAddress }, 'Protocol token pool not found')
      throw new Error('Protocol token pool not found')
    }

    return poolMetadata
  }

  private async getProtocolTokenApy({
    protocolTokenAddress,
    blockNumber,
  }: GetApyInput): Promise<number> {
    const poolContract = Cerc20__factory.connect(
      protocolTokenAddress,
      this.provider,
    )

    const srpb = await poolContract.supplyRatePerBlock.staticCall({
      blockTag: blockNumber,
    })
    const apr = (Number(srpb) * Number(SECONDS_PER_YEAR)) / Number(1e18)
    const apy = aprToApy(apr, SECONDS_PER_YEAR)

    return apy
  }

  private async getProtocolTokenApr({
    protocolTokenAddress,
    blockNumber,
  }: GetAprInput): Promise<number> {
    const poolContract = Cerc20__factory.connect(
      protocolTokenAddress,
      this.provider,
    )
    const underlyingTokenMetadata = (
      await this.fetchPoolMetadata(protocolTokenAddress)
    ).underlyingToken

    const speedContract = Speed__factory.connect(
      contractAddresses[this.chainId]!.speed,
      this.provider,
    )

    const oracleContract = Oracle__factory.connect(
      contractAddresses[this.chainId]!.oracle,
      this.provider,
    )

    const velocoreContract = Velocore__factory.connect(
      contractAddresses[this.chainId]!.velocore,
      this.provider,
    )

    const converterContract = Converter__factory.connect(
      contractAddresses[this.chainId]!.converter,
      this.provider,
    )

    const mendiAddress = contractAddresses[this.chainId]!.mendi

    const convertValue = await converterContract.latestAnswer.staticCall({
      blockTag: blockNumber,
    })

    const baseTokenBytes32 =
      '0x' +
      contractAddresses[this.chainId]!.usdcE.toLowerCase()
        .replace(/^0x/, '')
        .padStart(64, '0')

    const quoteTokenBytes32 =
      '0x' + mendiAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')

    const mPrice = await velocoreContract.spotPrice.staticCall(
      quoteTokenBytes32,
      baseTokenBytes32,
      10n ** 18n,
      { blockTag: blockNumber },
    )
    const mPriceFixed = (
      (Number(mPrice) / 1e6) *
      (Number(convertValue) / 1e8)
    ).toFixed(3)

    const supplySpeed = await speedContract.rewardMarketState.staticCall(
      mendiAddress,
      protocolTokenAddress,
      { blockTag: blockNumber },
    )

    const tokenSupply = await poolContract.totalSupply.staticCall({
      blockTag: blockNumber,
    })

    const exchangeRateStored = await poolContract.exchangeRateStored.staticCall(
      { blockTag: blockNumber },
    )

    const underlingPrice = await oracleContract.getPrice.staticCall(
      protocolTokenAddress,
      { blockTag: blockNumber },
    )

    const tokenDecimal = underlyingTokenMetadata.decimals

    const marketTotalSupply =
      (Number(tokenSupply) / Math.pow(10, tokenDecimal)) *
      (Number(exchangeRateStored) / 1e18) *
      Number(underlingPrice)
    const apr =
      (Number(supplySpeed.supplySpeed) *
        Number(mPriceFixed) *
        SECONDS_PER_YEAR) /
      marketTotalSupply

    return apr
  }
}
