import { ArticleHeader, H2 } from '@/components/pages/docs/components'

const faqs = [
  {
    q: 'Do I need to lock up ALGO to vote?',
    a: 'No. Voting power comes only from the blocks your account produced — there is no staking, lock-up, or sign-up.',
  },
  {
    q: 'Do I need to opt in or register first?',
    a: "No. There's nothing to sign up for: block production is your membership. If your account produced blocks during a committee's window, your account is automatically a member of that committee.",
  },
  {
    q: 'How is my voting power calculated?',
    a: "It is the number of blocks your account produced during the committee's window — one block, one vote. Each period is assigned one committee, so your power can differ between periods.",
  },
  {
    q: 'Can I change my vote?',
    a: 'Yes. While a period is active you can update your vote as often as you like. Your last vote before it closes is the one that counts.',
  },
  {
    q: 'What if I delegate and then vote myself?',
    a: "Voting for yourself shuts your delegate out for the rest of the period — you can still change your vote, but they can't.",
  },
  {
    q: 'I stake ALGO through a pool (xALGO, tALGO, Réti). Can I vote?',
    a: "Yes. Your share of the pool's voting power is yours to cast — pooled positions appear next to your own accounts on any open period. If you don't vote, your share counts as Abstain: the pool can't decide on your behalf.",
  },
  {
    q: "Why are an election's candidates in a different order on my other device?",
    a: "Because each browser gets its own candidate order, so that being listed first isn't an advantage. Your order stays the same every time you come back on that browser, and it never affects the result — candidates are ranked by net score alone.",
  },
  {
    q: 'When can I vote?',
    a: 'While a period is active. Upcoming periods can be read in advance, and ended periods show final results.',
  },
  {
    q: 'Where are results stored?',
    a: "Every vote is recorded on-chain — anyone can check the running tally at any point, or verify the final result. A pooled vote lands in two places: your own ballot in the pool's internal records, and the members' combined vote on the period itself.",
  },
]

const glossary = [
  {
    term: 'Block',
    def: 'A batch of transactions added to the chain. Producing blocks is what gives an account voting power.',
  },
  {
    term: 'Round',
    def: "Algorand's unit of time — one round per block. Committees cover a range of rounds: the committee window, typically 3M rounds.",
  },
  {
    term: 'Voting power',
    def: "The number of blocks your account produced in a committee's window. One block, one vote.",
  },
  {
    term: 'Committee',
    def: 'The set of accounts eligible to vote in a period, each with power from the blocks it produced in the committee window.',
  },
  {
    term: 'Period',
    def: 'A session of governance with a start and end, containing one or more topics to decide — or, in an election period, candidates to rank.',
  },
  {
    term: 'Topic',
    def: 'A single decision within a period — a question to answer. In an election period the same thing is called a candidate.',
  },
  {
    term: 'Election',
    def: 'A period that fills seats instead of answering questions. Candidates are ranked by net score and the top few lead for the seats. One period can run several elections at once.',
  },
  {
    term: 'Candidate',
    def: 'Someone standing in an election. You vote Support, Veto or Abstain on each one, and each candidate runs in exactly one of the period’s elections.',
  },
  {
    term: 'Delegation',
    def: 'Letting another account vote with your voting power, or voting on behalf of others.',
  },
  {
    term: 'Pooled voting',
    def: "Voting your prorated share of a staking pool's power. Members' votes are weighted, combined and cast on-chain.",
  },
  {
    term: 'AlgoQuarter (AQ)',
    def: "A pool's unit of member contribution: 1 ALGO staked for a full 3M-block window equals 1 AQ. Your AQ share is your share of the pool's voting power.",
  },
  {
    term: 'Governor',
    def: 'Any account taking part in governance by voting or delegating.',
  },
]

export default function Faq() {
  return (
    <div>
      <ArticleHeader to="/docs/faq" />
      <p className="mb-[34px] mt-[22px] max-w-[60ch] font-sans text-[20px] leading-[1.6] text-muted-foreground">
        Quick answers to common questions, and plain-language definitions of the words you'll see.
      </p>

      <div className="flex flex-col">
        {faqs.map((f) => (
          <div key={f.q} className="border-t border-border py-5">
            <div className="font-display text-[18px] font-bold text-foreground">{f.q}</div>
            <p className="mt-2 max-w-[62ch] font-sans text-[16px] leading-[1.65] text-muted-foreground">{f.a}</p>
          </div>
        ))}
      </div>

      <H2>Glossary</H2>
      <div className="mt-2 flex flex-col">
        {glossary.map((g) => (
          <div
            key={g.term}
            className="grid grid-cols-[120px_1fr] gap-[18px] border-t border-border py-[15px] sm:grid-cols-[180px_1fr]"
          >
            <div className="font-sans text-[15px] font-semibold text-foreground">{g.term}</div>
            <div className="font-sans text-[15px] leading-[1.6] text-muted-foreground">{g.def}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
