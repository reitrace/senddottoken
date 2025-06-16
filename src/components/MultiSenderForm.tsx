// MultiSenderForm.tsx
"use client";

import { useState, useMemo } from "react";
import { encodeFunctionData, parseUnits, type Address } from "viem";
import { useAppKitAccount } from "@reown/appkit/react-core";
import { multisenderAddress, config } from "@/config";
import { Spinner } from "./Spinner";
import { Toast } from "./Toast";
import { useClientMounted } from "@/hooks/useClientMount";
import { useSendTransaction, useBalance } from "wagmi";
import { resolveRecipient } from "@/utils/lensAccounts";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { tokenList, TokenSymbol } from "@/constants/tokens";

/* ---------- ABIs ---------- */
const abi = [
  {
    name: "disperseEther",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "disperseToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
] as const;

const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/* ---------- Types ---------- */
type Entry = { recipient: string; amount: string };

interface CardProps {
  index: number;
  entry: Entry;
  onChange: (i: number, field: keyof Entry, value: string) => void;
  onRemove: (i: number) => void;
}

/* ---------- Sub-component ---------- */
const RecipientCard = ({ index, entry, onChange, onRemove }: CardProps) => (
  <div className="card recipient-card">
    <input
      className="input recipient-input"
      value={entry.recipient}
      placeholder="0x… or Lens handle"
      onChange={(e) => onChange(index, "recipient", e.target.value)}
    />

    <input
      className="input amount-input"
      type="number"
      min="0"
      step="any"
      value={entry.amount}
      placeholder="Amount"
      onChange={(e) => onChange(index, "amount", e.target.value)}
    />

    <button
      type="button"
      className="btn btn-error btn-sm"
      onClick={() => onRemove(index)}
    >
      ✕
    </button>
  </div>
);

/* ---------- Env ---------- */
const tipRecipient = process.env.NEXT_PUBLIC_TIP_RECIPIENT;

/* ---------- Main component ---------- */
export const MultiSenderForm = () => {
  const { address, isConnected } = useAppKitAccount();
  const mounted = useClientMounted();

  /* ----- State ----- */
  const [rows, setRows] = useState<Entry[]>([{ recipient: "", amount: "" }]);
  const [selectedSymbol, setSelectedSymbol] = useState<TokenSymbol>(
    tokenList[0].symbol,
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [txLink, setTxLink] = useState<string | null>(null);
  const [tipAmount, setTipAmount] = useState("");

  /* ----- Token selection ----- */
  const selectedToken = tokenList.find((t) => t.symbol === selectedSymbol)!;

  /* ----- Wagmi hooks ----- */
  const { data: nativeBalance } = useBalance({ address: address as Address });
  const { data: tokenBalance } = useBalance({
    address: address as Address,
    token: selectedToken.address as Address,
  });
  const { sendTransactionAsync } = useSendTransaction();

  /* ----- Summary ----- */
  const summary = useMemo(() => {
    let count = 0;
    let total = 0n;

    rows.forEach(({ amount }) => {
      if (amount) {
        count++;
        try {
          total += parseUnits(amount, selectedToken.decimals);
        } catch {
          /* ignore */
        }
      }
    });

    if (
      tipRecipient &&
      tipAmount &&
      !isNaN(Number(tipAmount)) &&
      Number(tipAmount) > 0
    ) {
      try {
        total += parseUnits(tipAmount, selectedToken.decimals);
        count++;
      } catch {
        /* ignore */
      }
    }

    return { count, total };
  }, [rows, selectedToken, tipAmount]);

  const userBalance = selectedToken.address
    ? tokenBalance?.value ?? 0n
    : nativeBalance?.value ?? 0n;

  const prettyTotal = useMemo(() => {
    return `${(
      Number(summary.total) /
      10 ** selectedToken.decimals
    ).toLocaleString(undefined, { maximumFractionDigits: 6 })} $${selectedSymbol}`;
  }, [summary.total, selectedToken.decimals, selectedSymbol]);

  /* ----- CSV upload ----- */
  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = String(ev.target?.result ?? "");
      const newRows: Entry[] = [];

      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach((line) => {
          const [recipient, amount] = line.split(",");
          if (recipient && amount) {
            newRows.push({ recipient: recipient.trim(), amount: amount.trim() });
          }
        });

      if (newRows.length) setRows((r) => [...r, ...newRows]);
      else setError("No valid rows found in CSV");
    };
    reader.readAsText(file);
  };

  /* ----- Submit handler (unchanged) ----- */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus(null);
    setError(null);
    setTxLink(null);

    if (!isConnected || !address) {
      setError("Wallet not connected");
      setLoading(false);
      return;
    }
    if (!multisenderAddress) {
      setError("Multisender address is not configured");
      setLoading(false);
      return;
    }

    const recips: Address[] = [];
    const values: bigint[] = [];

    for (const { recipient, amount } of rows) {
      if (recipient && amount) {
        try {
          const resolved = await resolveRecipient(recipient.trim());
          recips.push(resolved as Address);
          values.push(parseUnits(amount.trim(), selectedToken.decimals));
        } catch {
          setError(`Invalid recipient: ${recipient.trim()}`);
          setLoading(false);
          return;
        }
      }
    }

    if (
      tipRecipient &&
      tipAmount &&
      !isNaN(Number(tipAmount)) &&
      Number(tipAmount) > 0
    ) {
      try {
        recips.push(tipRecipient as Address);
        values.push(parseUnits(tipAmount, selectedToken.decimals));
      } catch {
        /* ignore */
      }
    }

    if (recips.length === 0) {
      setError("No valid entries");
      setLoading(false);
      return;
    }

    const total = values.reduce((s, v) => s + v, 0n);
    if (userBalance < total) {
      setError("Insufficient balance");
      setLoading(false);
      return;
    }

    try {
      /* Allowance logic … (unchanged) */
      if (selectedToken.address) {
        const allowance = await readContract(config, {
          abi: erc20Abi,
          address: selectedToken.address as Address,
          functionName: "allowance",
          args: [address as Address, multisenderAddress as Address],
        });
        if (allowance < total) {
          const approveData = encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [multisenderAddress as Address, total],
          });
          const approveHash = await sendTransactionAsync({
            to: selectedToken.address as Address,
            data: approveData,
            account: address as Address,
          });
          setStatus(
            `Approval tx sent: https://explorer.lens.xyz/tx/${approveHash}`,
          );
          await waitForTransactionReceipt(config, { hash: approveHash });
        }
      }

      /* Main multisend */ /* … unchanged … */
      let data: `0x${string}`;
      if (selectedToken.address) {
        data = encodeFunctionData({
          abi,
          functionName: "disperseToken",
          args: [selectedToken.address as Address, recips, values],
        });
      } else {
        data = encodeFunctionData({
          abi,
          functionName: "disperseEther",
          args: [recips, values],
        });
      }

      const hash = await sendTransactionAsync({
        to: multisenderAddress as Address,
        data,
        value: selectedToken.address ? undefined : total,
        account: address as Address,
      });
      const url = `https://explorer.lens.xyz/tx/${hash}`;
      setTxLink(url);
      setStatus(`Transaction sent: ${url}`);
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
      else setError("Transaction failed");
    } finally {
      setLoading(false);
    }
  };

  /* ---------- UI ---------- */
  if (!mounted) return null;

  return (
    <form onSubmit={handleSubmit} className="card field">
      {/* 1. Token selector */}
      <div className="field-row">
        <label htmlFor="token">Token</label>
        <select
          id="token"
          className="select"
          value={selectedSymbol}
          onChange={(e) => setSelectedSymbol(e.target.value as TokenSymbol)}
        >
          {tokenList.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
        {isConnected && (
          <span className="total-line" style={{ fontSize: 12 }}>
            Balance:{" "}
            {selectedToken.address
              ? tokenBalance?.formatted
              : nativeBalance?.formatted}{" "}
            ${selectedSymbol}
          </span>
        )}
      </div>

      {/* 2. Recipient cards */}
      {rows.map((entry, i) => (
        <RecipientCard
          key={i}
          index={i}
          entry={entry}
          onChange={(idx, field, val) =>
            setRows((r) =>
              r.map((row, j) =>
                idx === j ? { ...row, [field]: val } : row,
              ),
            )
          }
          onRemove={(idx) => setRows((r) => r.filter((_, j) => j !== idx))}
        />
      ))}

      <button
        type="button"
        className="btn btn-outline btn-sm"
        onClick={() => setRows((r) => [...r, { recipient: "", amount: "" }])}
        style={{ marginBottom: 12 }}
      >
        + Add recipient
      </button>

      {/* CSV upload */}
      <input
        type="file"
        accept=".csv,text/csv"
        className="file-input"
        onChange={handleCsvUpload}
        style={{ marginBottom: 12 }}
      />

      {/* 3. Totals */}
      <div className="total-line">
        <span>Total recipients: {summary.count}</span>
        <span>Total amount: {prettyTotal}</span>
      </div>

      {/* 4. Optional tip */}
      {tipRecipient && (
        <div className="field-row" style={{ marginTop: 8 }}>
          <label htmlFor="tip-amount">
            Tip developer <span style={{ fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id="tip-amount"
            type="number"
            className="select"
            value={tipAmount}
            onChange={(e) => setTipAmount(e.target.value)}
            min="0"
            step="any"
            placeholder="0"
          />
        </div>
      )}

      {/* 5. Primary action */}
      <button
        className="btn btn-primary btn-lg"
        type="submit"
        disabled={loading || !isConnected}
        style={{ marginTop: 12 }}
      >
        {loading ? <Spinner /> : "Send"}
      </button>

      {/* 6. Feedback */}
      {status && (
        <Toast
          message={status}
          type="success"
          onClose={() => setStatus(null)}
        />
      )}
      {error && (
        <Toast message={error} type="error" onClose={() => setError(null)} />
      )}
      {txLink && (
        <a
          href={txLink}
          target="_blank"
          rel="noopener noreferrer"
          style={{ marginTop: 8, display: "block" }}
        >
          View transaction
        </a>
      )}
    </form>
  );
};
