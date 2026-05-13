// Error codes for contracts - messages in comments are parsed by SDK build script
export const errUnauthorized = 'ERR:AUTH' // Unauthorized - caller must be admin

// Committee errors
export const errCommitteeExists = 'ERR:C_EX' // Committee already exists
export const errCommitteeNotExists = 'ERR:C_NX' // Committee does not exist
export const errPeriodEndLessThanStart = 'ERR:PE_LT' // Period end must be greater than period start
export const errIngestedVotesNotZero = 'ERR:IV_NZ' // Cannot unregister committee with ingested votes (votes must be zero)
export const errTotalXGovsExceeded = 'ERR:TX_XC' // Total xGovs exceeded
export const errTotalVotesExceeded = 'ERR:TV_XC' // Total votes exceeded
export const errTotalVotesMismatch = 'ERR:TV_MM' // Total votes mismatch - ingested votes must equal total votes when finished
export const errNumXGovsExceeded = 'ERR:NX_XC' // Number of xGovs to uningest exceeds total xGovs
export const errOutOfOrder = 'ERR:OOO' // xGovs must be added in ascending order by account ID
export const errCommitteeIncomplete = 'ERR:C_NC' // Committee is incomplete - not all votes have been ingested
export const errTotalMembersZero = 'ERR:TM_Z' // Total members must be greater than zero
export const errTotalVotesZero = 'ERR:TV_Z' // Total votes must be greater than zero
export const errTotalMembersOverflow = 'ERR:TM_OV' // Total members exceeds maximum (65535)
export const errCommitteeIdOverflow = 'ERR:CI_OV' // Committee numeric ID exceeds maximum (65535)

// Account errors
export const errAccountExists = 'ERR:A_EX' // Account already exists
export const errAccountNotExists = 'ERR:A_NX' // Account does not exist
export const errAccountIdMismatch = 'ERR:ID' // Account ID mismatch

// Account offset errors
export const errAccountOffsetExists = 'ERR:AO_EX' // Account offset already exists
export const errAccountOffsetNotExists = 'ERR:AO_NX' // Account offset does not exist
export const errAccountOffsetMismatch = 'ERR:AO_MM' // Account offset mismatch

// Algohour errors
export const errAlgoHoursExist = 'ERR:AH_EX' // Algohour account entry already exists
export const errAlgoHoursNotExist = 'ERR:AH_NX' // Algohour account entry does not exist
export const errAlgoHoursNotFinal = 'ERR:AH_NF' // Algohour account entry is not final
export const errAlgoHoursMismatch = 'ERR:AH' // Algohour mismatch - account does not have expected algohours

export const errPeriodStartInvalid = 'ERR:PS' // Period start is invalid - must align with period length (1M)
export const errPeriodEndInvalid = 'ERR:PE' // Period end is invalid - must align with period length (1M)
export const errNoVotingPower = 'ERR:A_NV' // No voting power for account

// xGov sync errors
export const errXGovRegistryMissing = 'ERR:XGRM' // xGov registry app ID in oracle is missing
export const errXGovProposalInvalidCreator = 'ERR:XGPC' // Proposal creator does not match xGov registry escrow
export const errXGovProposalCommitteeMissing = 'ERR:XGPM' // Committee ID missing from proposal. This should never happen.
export const errXGovProposalVoteOpenTsMissing = 'ERR:XGVOM' // Vote open timestamp missing from proposal. This should never happen.
export const errXGovProposalVotingDurationMissing = 'ERR:XGVDM' // Voting duration missing from proposal. This should never happen.
export const errXGovProposalStatusMissing = 'ERR:XGSM' // Status missing from proposal. This should never happen.

export const errProposalExists = 'ERR:P_EX' // Proposal already exists in delegator
export const errProposalNotExists = 'ERR:P_NX' // Proposal does not exist in delegator
export const errProposalCancelled = 'ERR:P_C' // Proposal has been cancelled
export const errEarly = 'ERR:EAR' // Too early to perform this action
export const errLate = 'ERR:LAT' // Too late to perform this action
export const errIncorrectVotes = 'ERR:IV' // Incorrect vote total - vote totals must match the account voting power
export const errNoVotes = 'ERR:NV' // No votes found
export const errAccountNumMismatch = 'ERR:ANM' // Number of accounts provided does not match number of accounts with pending votes in proposal
export const errState = 'ERR:ST' // Invalid state for this action

// gGov auth
export const errNotOperator = 'ERR:G_OP' // Caller must be operator
export const errAlreadyInit = 'ERR:AI' // Contract already initialised

// gGov period
export const errGGovPeriodExists = 'ERR:GP_EX' // Period already exists
export const errGGovPeriodNotExists = 'ERR:GP_NX' // Period does not exist
export const errPeriodAppNotConfigured = 'ERR:GP_NC' // Period approval program not yet uploaded to registry
export const errGGovVotingNotStarted = 'ERR:GP_NS' // Voting has not started
export const errGGovVotingEnded = 'ERR:GP_EN' // Voting period ended
export const errGGovHasVotes = 'ERR:GP_VE' // Cannot modify: votes exist
export const errGGovReady = 'ERR:GP_RD' // Cannot modify: period is marked ready
export const errGGovNotReady = 'ERR:GP_NR' // Cannot vote: period is not marked ready

// gGov topic
export const errGGovTopicIndexOOB = 'ERR:GT_OB' // Topic index out of bounds
export const errGGovNoOptions = 'ERR:GT_NO' // Topic must have at least one option

// gGov voting
export const errGGovVoteMismatch = 'ERR:GV_MM' // Vote array length mismatch
export const errGGovVotePowerMismatch = 'ERR:GV_VP' // Vote sum != voting power
export const errGGovCannotOverride = 'ERR:GV_OD' // Delegatee cannot override direct vote
export const errGGovNoDelegation = 'ERR:GD_NX' // No delegation for account
export const errGGovSelfDelegate = 'ERR:GD_SD' // Cannot delegate to self
