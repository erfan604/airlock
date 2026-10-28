/-
AIRLOCK verdict runner: reads vectors from stdin, one line each, and prints the outcome of the Lean model (VerdictModel) so
the differential test can compare it with the Rust verdict on the same lines.

Input line: exactly 21 natural numbers separated by spaces, in this order:
  amount, fee_kind, fee, gas_kind, gas, recipient, amount_labels, pc, asset_kind, hard_cap, remaining_daily, max_fee, max_gas,
  payee_kind, cap_kind, cap, budget, limit, task_kind, remaining, paused
A `*_kind` of 1 means the paired value is `some`, 0 means `none` (the paired value is then ignored). The three label columns are
u16 masks decoded by `toLabels`. `paused` is 0 or 1.

Output line: `allow`, `escalate:<Reason>` or `block:<Reason>` with the Rust variant name, or `error:malformed` for a line that is
not 21 natural numbers inside the Rust domain (every value below 2^128, label masks below 2^16, kinds and paused 0 or 1). The
loop continues after a malformed line, so a line-count check on the output catches it. Lean's Nat accepts a value at or above
2^128 silently while the Rust parse refuses it, which is why the domain is checked here and not left to the model.
-/
import VerdictModel

def reasonName : Reason → String
  | .unknownAsset => "UnknownAsset"
  | .paused => "Paused"
  | .amountOutOfBounds => "AmountOutOfBounds"
  | .dailyLimit => "DailyLimit"
  | .feeTooHigh => "FeeTooHigh"
  | .missingProvenance => "MissingProvenance"
  | .bookLabelNotInBook => "BookLabelNotInBook"
  | .outsideTask => "OutsideTask"
  | .overTaskBound => "OverTaskBound"
  | .untrustedTrigger => "UntrustedTrigger"
  | .untrustedRecipient => "UntrustedRecipient"
  | .newRecipient => "NewRecipient"
  | .overPayeeLimit => "OverPayeeLimit"
  | .untrustedAmount => "UntrustedAmount"

def tag : Verdict → String
  | .allow => "allow"
  | .escalate r => "escalate:" ++ reasonName r
  | .block r => "block:" ++ reasonName r

/-- The numbers of a line, or `none` when any token is not a plain run of decimal digits (a sign, a point, a letter). -/
def parseLine (line : String) : Option (Array Nat) :=
  let spaced := line.map (fun c => if c == '\t' || c == '\r' || c == '\n' then ' ' else c)
  let tokens := (spaced.splitOn " ").filter (fun s => s != "")
  if tokens.all (fun s => s.all Char.isDigit) then some (tokens.map String.toNat!).toArray else none

/-- Columns that only take 0 or 1: the six `*_kind` columns and `paused`. -/
def flagColumns : List Nat := [1, 3, 8, 13, 14, 18, 20]

/-- The three label masks (recipient, amount_labels, pc). -/
def labelColumns : List Nat := [5, 6, 7]

/-- The Rust domain: 21 columns, every value a u128, label masks a u16, flags 0 or 1. -/
def inDomain (xs : Array Nat) : Bool :=
  xs.size == 21 && xs.all (· < 2 ^ 128) && flagColumns.all (fun i => xs.getD i 0 ≤ 1) &&
    labelColumns.all (fun i => xs.getD i 0 < 2 ^ 16)

def runLine (line : String) : String :=
  match parseLine line with
  | none => "error:malformed"
  | some xs =>
    if !inDomain xs then "error:malformed"
    else
      let g := fun (i : Nat) => xs.getD i 0
      let opt := fun (k v : Nat) => if g k == 1 then some (g v) else none
      let r : Request :=
        { amount := g 0, fee := opt 1 2, gas := opt 3 4,
          recipient := toLabels (g 5), amountL := toLabels (g 6), pc := toLabels (g 7) }
      let asset : Option Limits :=
        if g 8 == 1 then some { hardCap := g 9, remainingDaily := g 10, maxFee := g 11, maxGas := g 12 } else none
      let payee : Option Payee :=
        if g 13 == 1 then some { cap := opt 14 15, budget := g 16, limit := g 17 } else none
      let task : Option TaskScope := if g 18 == 1 then some { remaining := g 19 } else none
      tag (verdict r asset payee task { paused := g 20 == 1 })

partial def loop (inp out : IO.FS.Stream) : IO Unit := do
  let line ← inp.getLine
  if line.isEmpty then return
  out.putStrLn (runLine line)
  loop inp out

def main : IO Unit := do
  let out ← IO.getStdout
  loop (← IO.getStdin) out
  out.flush

/-! Build-time tests of the runner (each `#guard` fails the build when false). -/

/-- The base line of the toggle generator: it satisfies all 17 conditions of `allow_iff`. -/
def baseColumns : List Nat := [100, 1, 10, 1, 21000, 2, 32, 1, 1, 1000, 1000, 50, 100000, 1, 1, 500, 500, 1000, 1, 1000, 0]

/-- The base line with some columns replaced. -/
def edited (edits : List (Nat × Nat)) : String :=
  String.intercalate " " ((baseColumns.mapIdx (fun i v => (edits.lookup i).getD v)).map toString)

#guard runLine (edited []) == "allow"

-- one flip per condition: every one of the 14 reasons comes out with the Rust variant name
#guard [(edited [(8, 0)], "block:UnknownAsset"), (edited [(20, 1)], "block:Paused"),
    (edited [(0, 0)], "block:AmountOutOfBounds"), (edited [(9, 99)], "block:AmountOutOfBounds"),
    (edited [(10, 99)], "block:DailyLimit"), (edited [(2, 51)], "block:FeeTooHigh"),
    (edited [(4, 100001)], "block:FeeTooHigh"), (edited [(5, 0)], "block:MissingProvenance"),
    (edited [(6, 0)], "block:MissingProvenance"), (edited [(7, 0)], "block:MissingProvenance"),
    (edited [(18, 0)], "escalate:OutsideTask"), (edited [(19, 99)], "escalate:OverTaskBound"),
    (edited [(7, 33)], "escalate:UntrustedTrigger"), (edited [(5, 34)], "escalate:UntrustedRecipient"),
    (edited [(13, 0)], "block:BookLabelNotInBook"), (edited [(13, 0), (5, 1)], "escalate:NewRecipient"),
    (edited [(17, 99)], "escalate:OverPayeeLimit"), (edited [(14, 0)], "escalate:UntrustedAmount"),
    (edited [(15, 99)], "escalate:UntrustedAmount"), (edited [(6, 16)], "escalate:UntrustedAmount"),
    (edited [(16, 99)], "escalate:UntrustedAmount")].all (fun (l, e) => runLine l == e)

-- ignored values: a `none` column pays no attention to its paired value
#guard runLine (edited [(1, 0), (2, 999999), (3, 0), (4, 999999)]) == "allow"
#guard runLine (edited [(14, 0), (15, 1000)]) == "escalate:UntrustedAmount"

-- the check 3 line of AIR-022 (row 1 of the vector table)
#guard runLine "10 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000 0" == "allow"

-- malformed lines print `error:malformed` and the loop goes on
#guard runLine "" == "error:malformed"
#guard runLine "\n" == "error:malformed"
#guard runLine "10 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000" == "error:malformed"
#guard runLine "10 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000 0 0" == "error:malformed"
#guard runLine (edited [(0, 1)] ++ " x") == "error:malformed"
#guard runLine "x 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000 0" == "error:malformed"
#guard runLine "-10 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000 0" == "error:malformed"
#guard runLine "1.5 0 0 0 0 2 1 1 1 1000 1000 50 100000 1 0 0 0 1000 1 1000 0" == "error:malformed"

-- the Rust domain: a column at or above 2^128 or a label mask at or above 2^16 is refused, the maxima are accepted
#guard runLine (edited [(0, 2 ^ 128)]) == "error:malformed"
#guard runLine (edited [(19, 2 ^ 128)]) == "error:malformed"
#guard runLine (edited [(0, 2 ^ 128 - 1), (9, 2 ^ 128 - 1), (10, 2 ^ 128 - 1), (19, 2 ^ 128 - 1), (17, 2 ^ 128 - 1),
    (15, 2 ^ 128 - 1), (16, 2 ^ 128 - 1)]) == "allow"
#guard runLine (edited [(5, 65536)]) == "error:malformed"
#guard runLine (edited [(7, 65536)]) == "error:malformed"
#guard runLine (edited [(5, 65535)]) == "escalate:UntrustedRecipient"
#guard runLine (edited [(1, 2)]) == "error:malformed"
#guard runLine (edited [(13, 2)]) == "error:malformed"
#guard runLine (edited [(20, 2)]) == "error:malformed"

-- tabs, carriage returns and repeated spaces separate columns
#guard runLine ("100  1\t10 1 21000 2 32 1 1 1000 1000 50 100000 1 1 500 500 1000 1 1000 0\r\n") == "allow"
