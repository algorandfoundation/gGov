// Error codes for contracts - messages in comments are parsed by SDK build script
export const errUnauthorized = 'AUTH' // Unauthorized - you do not have permissions to perform this action

// Committee errors
export const errCommitteeExists = 'C_EX' // Committee already exists
export const errCommitteeNotExists = 'C_NX' // Committee does not exist
export const errPeriodEndLessThanStart = 'PE_LT' // Period end must be greater than period start
export const errIngestedVotesNotZero = 'IV_NZ' // Cannot unregister committee with ingested votes (votes must be zero)
export const errTotalGovsExceeded = 'TX_XC' // Total accounts exceeded
export const errTotalVotesExceeded = 'TV_XC' // Total votes exceeded
export const errZeroVotes = 'V_Z' // Gov votes must be greater than zero
export const errTotalVotesMismatch = 'TV_MM' // Total votes mismatch - ingested votes must equal total votes when finished
export const errNumGovsExceeded = 'NX_XC' // Number of govs to uningest exceeds total govs
export const errOutOfOrder = 'OOO' // Govs must be added in ascending order by account ID
export const errCommitteeIncomplete = 'C_NC' // Committee is incomplete - not all votes have been ingested
export const errTotalMembersZero = 'TM_Z' // Total members must be greater than zero
export const errTotalVotesZero = 'TV_Z' // Total votes must be greater than zero
export const errTotalMembersOverflow = 'TM_OV' // Total members exceeds maximum (65535)
export const errCommitteeIdOverflow = 'CI_OV' // Committee numeric ID exceeds maximum (65535)

// Account errors
export const errAccountExists = 'A_EX' // Account already exists
export const errAccountNotExists = 'A_NX' // Account does not exist
export const errAccountIdMismatch = 'ID' // Account ID mismatch

// Account offset errors
export const errAccountOffsetExists = 'AO_EX' // Account offset already exists
export const errAccountOffsetNotExists = 'AO_NX' // Account offset does not exist
export const errAccountOffsetMismatch = 'AO_MM' // Account offset mismatch

// Algohour errors
export const errAlgoHoursExist = 'AH_EX' // Algohour account entry already exists
export const errAlgoHoursNotExist = 'AH_NX' // Algohour account entry does not exist
export const errAlgoHoursNotFinal = 'AH_NF' // Algohour account entry is not final
export const errAlgoHoursMismatch = 'AH' // Algohour mismatch - account does not have expected algohours

export const errPeriodStartInvalid = 'PS' // Period start is invalid - must align with period length (1M)
export const errPeriodEndInvalid = 'PE' // Period end is invalid - must align with period length (1M)
export const errNoVotingPower = 'A_NV' // No voting power for account

// xGov sync errors
export const errRegistryMissing = 'RM' // Registry configuration is missing
export const errXGovProposalInvalidCreator = 'XGPC' // Proposal creator does not match xGov registry escrow
export const errXGovProposalCommitteeMissing = 'XGPM' // Committee ID missing from proposal. This should never happen.
export const errXGovProposalVoteOpenTsMissing = 'XGVOM' // Vote open timestamp missing from proposal. This should never happen.
export const errXGovProposalVotingDurationMissing = 'XGVDM' // Voting duration missing from proposal. This should never happen.
export const errXGovProposalStatusMissing = 'XGSM' // Status missing from proposal. This should never happen.

export const errProposalCancelled = 'P_C' // Proposal has been cancelled
export const errEarly = 'EAR' // Too early to perform this action
export const errLate = 'LAT' // Too late to perform this action
export const errIncorrectVotes = 'IV' // Incorrect vote total - vote totals must match the account voting power
export const errNoVotes = 'NV' // No votes found
export const errAccountNumMismatch = 'ANM' // Number of accounts provided does not match number of accounts with pending votes in proposal
export const errState = 'ST' // Invalid state for this action

// gGov auth
export const errAlreadyInit = 'AI' // Contract already initialised

// gGov period
export const errGGovPeriodExists = 'GP_EX' // Period already exists
export const errGGovPeriodNotExists = 'GP_NX' // Period does not exist
export const errPeriodAppNotConfigured = 'GP_NC' // Period approval program not yet uploaded to registry
export const errPeriodInRange = 'P_IR' // Cannot set period counter: a period exists in the affected id range
export const errGGovVotingNotStarted = 'GP_NS' // Voting has not started
export const errGGovVotingEnded = 'GP_EN' // Voting period ended
export const errGGovHasVotes = 'GP_VE' // Cannot modify: votes exist
export const errGGovReady = 'GP_RD' // Cannot modify: period is marked ready
export const errGGovNotReady = 'GP_NR' // Cannot vote: period is not marked ready
export const errGGovUnvotable = 'GP_UV' // Cannot ready: vote event would exceed the 1024-byte log limit

// gGov topic
export const errGGovTopicIndexOOB = 'GT_OB' // Topic index out of bounds
export const errGGovNoOptions = 'GT_NO' // Topic must have at least one option

// gGov voting
export const errGGovVoteMismatch = 'GV_MM' // Vote array length mismatch
export const errGGovVotePowerMismatch = 'GV_VP' // Vote sum != voting power
export const errGGovCannotOverride = 'GV_OD' // Delegatee cannot override direct vote
export const errGGovNoDelegation = 'GD_NX' // No delegation for account
export const errGGovDelegationNoAcctRef = 'GD_NR' // Transaction malformed - no account reference to delegator
export const errGGovSelfDelegate = 'GD_SD' // Cannot delegate to self
export const errGGovDelegationExists = 'GD_EX' // Delegation already exists for account

// Frac delegation
export const errInstanceAppNotConfigured = 'FI_NC' // Instance approval program not yet uploaded to registry
export const errInstanceAppNotExists = 'FI_NX' // Instance does not exist
export const errEscrowAssigned = 'FE_AS' // Escrow account is already assigned to an instance
export const errNoEscrows = 'FE_NX' // Instance has no registered escrows
export const errEscrowNotAssigned = 'FE_NA' // Escrow account is not assigned to any instance
export const errPeriodAppMismatch = 'FP_MM' // Period app does not match the synced period record

// Frac AlgoQuarters (AQ) ingestion
export const errTotalAqZero = 'FA_TZ' // Total AlgoQuarters must be greater than zero
export const errTotalAccountsZero = 'FA_AZ' // Total accounts must be greater than zero
export const errZeroAq = 'FA_Z' // Account AlgoQuarters must be greater than zero
export const errAqNotStarted = 'FA_NS' // AlgoQuarters ingest has not been started for this committee
export const errIngestedAqNotZero = 'FA_NZ' // Cannot re-set total AlgoQuarters: AlgoQuarters have already been ingested
export const errAccountAqExists = 'FA_EX' // Account AlgoQuarters already ingested for this committee
export const errTotalAqExceeded = 'FA_XC' // Ingested AlgoQuarters exceed the committee total
export const errAqIncomplete = 'FA_NC' // AlgoQuarters ingest is incomplete - not all AlgoQuarters have been ingested
export const errAccountAqNotExists = 'FA_NX' // Account AlgoQuarters not ingested for this committee
