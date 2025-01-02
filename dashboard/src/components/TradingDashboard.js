// src/components/TradingDashboard.js
import React from 'react';
import { Fragment, useState } from 'react';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import {
  TrendingDown,
  TrendingUp,
  MoreHorizontal,
  Bell,
  Menu as MenuIcon,
  X,
  Plus
} from 'lucide-react';

const navigation = [
  { name: 'Home', href: '#' },
  { name: 'Dashboard', href: '#', current: true },
  { name: 'Positions', href: '#' },
  { name: 'Settings', href: '#' },
];

const timeFrames = [
  { name: 'Last 24h', href: '#', current: true },
  { name: 'Last 7d', href: '#', current: false },
  { name: 'All-time', href: '#', current: false },
];

// Sample trading data - would come from your position cache
const tradingData = {
  positions: {
    "3d3d1822ee46": {
      "id": "3d3d1822ee46",
      "symbol": "BTC",
      "direction": "short",
      "openedAt": 1735782947332,
      "initialData": {
        "size": -0.001,
        "costOfTrades": 94.760452,
        "accountBalance": 25.815809,
        "openPrice": 94760.452
      },
      "state": {
        "hasReachedThreshold": true,
        "highestProgress": 1.573234321464994,
        "lowestProgress": -0.1916460722852403,
        "thresholdHits": 0,
        "takeProfitHits": 0,
        "stopLossHits": 0,
        "trailingStopHits": 0,
        "highestPrice": 0,
        "lowestPrice": null,
        "trailingStopPrice": 95144.10307825,
        "entryPrice": 94760.452,
        "initialBalance": 25.815809,
        "lastCheckedPrice": 94903.51144999999,
        "currentDirection": "short",
        "isClosing": false,
        "trailingStatusMessage": "[BTC] 🔄 Now tracking 0.75% balance pullback from new highs"
      }
    },
    "515c5771f944": {
      "id": "515c5771f944", 
      "symbol": "ETH",
      "direction": "short",
      "openedAt": 1735782987744,
      "initialData": {
        "size": -0.03,
        "costOfTrades": 101.442336,
        "accountBalance": 25.714367,
        "openPrice": 3381.4112
      },
      "state": {
        "hasReachedThreshold": true,
        "highestProgress": 1.7646520021308083,
        "lowestProgress": -0.5998654905065328,
        "thresholdHits": 0,
        "takeProfitHits": 0,
        "stopLossHits": 0,
        "trailingStopHits": 0,
        "highestPrice": 0,
        "lowestPrice": null,
        "trailingStopPrice": 3394.2586385,
        "entryPrice": 3381.4112,
        "initialBalance": 25.714367,
        "lastCheckedPrice": 3382.2419,
        "currentDirection": "short",
        "isClosing": false,
        "trailingStatusMessage": "[ETH] 🔄 Now tracking 0.75% balance pullback from new highs"
      }
    }
  }
};

// Calculate stats from positions
const calculateStats = (positions) => {
  const positionValues = Object.values(positions);
  const totalBalance = positionValues.reduce((acc, pos) => acc + pos.initialData.accountBalance, 0);
  const totalPnL = positionValues.reduce((acc, pos) => acc + (pos.state.highestProgress || 0), 0);
  
  return [
    {
      name: 'Account Balance',
      value: `$${totalBalance.toFixed(2)}`,
      change: `${totalPnL.toFixed(2)}%`,
      changeType: totalPnL >= 0 ? 'positive' : 'negative',
    },
    {
      name: 'Open Positions',
      value: positionValues.length.toString(),
      change: 'Active',
      changeType: 'positive',
    },
    {
      name: 'Total P&L',
      value: `${totalPnL.toFixed(2)}%`,
      change: `${positionValues.length} positions`,
      changeType: totalPnL >= 0 ? 'positive' : 'negative',
    },
    {
      name: 'Success Rate',
      value: '75%',
      change: 'Last 7 days',
      changeType: 'positive',
    },
  ];
};

const stats = calculateStats(tradingData.positions);

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function TradingDashboard() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <header className="absolute inset-x-0 top-0 z-50 flex h-16 border-b border-gray-900/10">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex flex-1 items-center gap-x-6">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="-m-3 p-3 md:hidden"
            >
              <span className="sr-only">Open main menu</span>
              <MenuIcon className="h-6 w-6" />
            </button>
            <img
              className="h-8 w-auto"
              src="/api/placeholder/32/32"
              alt="Trading Dashboard"
            />
          </div>
          <nav className="hidden md:flex md:gap-x-11 md:text-sm/6 md:font-semibold md:text-gray-700">
            {navigation.map((item, itemIdx) => (
              <a key={itemIdx} href={item.href} className={item.current ? 'text-indigo-600' : ''}>
                {item.name}
              </a>
            ))}
          </nav>
          <div className="flex flex-1 items-center justify-end gap-x-8">
            <button
              type="button"
              className="-m-2.5 p-2.5 text-gray-400 hover:text-gray-500"
            >
              <span className="sr-only">View notifications</span>
              <Bell className="h-6 w-6" />
            </button>
            <a href="#" className="-m-1.5 p-1.5">
              <span className="sr-only">Your profile</span>
              <img
                className="h-8 w-8 rounded-full bg-gray-800"
                src="/api/placeholder/32/32"
                alt=""
              />
            </a>
          </div>
        </div>
      </header>

      <main className="relative isolate">
        <div className="overflow-hidden pt-16">
          {/* Secondary navigation */}
          <header className="pb-4 pt-6 sm:pb-6">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-6 px-4 sm:flex-nowrap sm:px-6 lg:px-8">
              <h1 className="text-base font-semibold leading-7 text-gray-900">
                Trading Dashboard
              </h1>
              <div className="order-last flex w-full gap-x-8 text-sm font-semibold leading-6 sm:order-none sm:w-auto sm:border-l sm:border-gray-200 sm:pl-6 sm:leading-7">
                {timeFrames.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    className={item.current ? 'text-indigo-600' : 'text-gray-700'}
                  >
                    {item.name}
                  </a>
                ))}
              </div>
              <button
                type="button"
                className="ml-auto flex items-center gap-x-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              >
                <Plus className="-ml-1.5 h-5 w-5" />
                New Position
              </button>
            </div>
          </header>

          {/* Stats */}
          <div className="border-b border-b-gray-900/10 lg:border-t lg:border-t-gray-900/5">
            <dl className="mx-auto grid max-w-7xl grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 lg:px-2 xl:px-0">
              {stats.map((stat, statIdx) => (
                <div
                  key={stat.name}
                  className={classNames(
                    statIdx % 2 === 1 ? 'sm:border-l' : statIdx === 2 ? 'lg:border-l' : '',
                    'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-gray-900/5 px-4 py-10 sm:px-6 lg:border-t-0 xl:px-8'
                  )}
                >
                  <dt className="text-sm font-medium leading-6 text-gray-500">{stat.name}</dt>
                  <dd
                    className={classNames(
                      stat.changeType === 'negative' ? 'text-rose-600' : 'text-gray-700',
                      'text-xs font-medium'
                    )}
                  >
                    {stat.change}
                  </dd>
                  <dd className="w-full flex-none text-3xl font-medium leading-10 tracking-tight text-gray-900">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Position Cards */}
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
            <div className="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold leading-7 text-gray-900">
                  Active Positions
                </h2>
                <a href="#" className="text-sm font-semibold leading-6 text-indigo-600 hover:text-indigo-500">
                  View all<span className="sr-only">, positions</span>
                </a>
              </div>
              <ul role="list" className="mt-6 grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-3 xl:gap-x-8">
                {Object.values(tradingData.positions).map((position) => (
                  <li key={position.id} className="overflow-hidden rounded-xl border border-gray-200">
                    <div className="flex items-center gap-x-4 border-b border-gray-900/5 bg-gray-50 p-6">
                      {position.direction === 'long' ? (
                        <TrendingUp className="h-6 w-6 text-green-500" />
                      ) : (
                        <TrendingDown className="h-6 w-6 text-red-500" />
                      )}
                      <div className="text-sm font-medium leading-6 text-gray-900">
                        {position.symbol} {position.direction.toUpperCase()}
                      </div>
                      <Menu as="div" className="relative ml-auto">
                        <MenuButton className="-m-2.5 block p-2.5 text-gray-400 hover:text-gray-500">
                          <span className="sr-only">Open options</span>
                          <MoreHorizontal className="h-5 w-5" />
                        </MenuButton>
                        <MenuItems className="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 focus:outline-none">
                          <MenuItem>
                            <a href="#" className="block px-3 py-1 text-sm leading-6 text-gray-900">
                              View<span className="sr-only">, {position.symbol}</span>
                            </a>
                          </MenuItem>
                          <MenuItem>
                            <a href="#" className="block px-3 py-1 text-sm leading-6 text-gray-900">
                              Close<span className="sr-only">, {position.symbol}</span>
                            </a>
                          </MenuItem>
                        </MenuItems>
                      </Menu>
                    </div>
                    <dl className="-my-3 divide-y divide-gray-100 px-6 py-4 text-sm leading-6">
                      <div className="flex justify-between gap-x-4 py-3">
                        <dt className="text-gray-500">Entry Price</dt>
                        <dd className="text-gray-700">
                          ${position.state.entryPrice.toFixed(2)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-x-4 py-3">
                        <dt className="text-gray-500">Current Price</dt>
                        <dd className="text-gray-700">
                          ${position.state.lastCheckedPrice.toFixed(2)}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-x-4 py-3">
                        <dt className="text-gray-500">Progress</dt>
                        <dd className="flex items-center gap-x-2">
                          <div className={position.state.highestProgress >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {position.state.highestProgress.toFixed(2)}%
                          </div>
                        </dd>
                      </div>
                      <div className="flex justify-between gap-x-4 py-3">
                        <dt className="text-gray-500">Status</dt>
                        <dd className="text-gray-700">
                          {position.state.hasReachedThreshold ? 'Threshold Reached' : 'Active'}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        {/* Mobile menu */}
        <Dialog as="div" className="lg:hidden" open={mobileMenuOpen} onClose={setMobileMenuOpen}>
          <div className="fixed inset-0 z-50" />
          <Dialog.Panel className="fixed inset-y-0 left-0 z-50 w-full overflow-y-auto bg-white px-4 pb-6 sm:max-w-sm sm:px-6 sm:ring-1 sm:ring-gray-900/10">
            <div className="-ml-0.5 flex h-16 items-center gap-x-6">
              <button
                type="button"
                className="-m-2.5 p-2.5 text-gray-700"
                onClick={() => setMobileMenuOpen(false)}
              >
                <span className="sr-only">Close menu</span>
                <X className="h-6 w-6" />
              </button>
              <div className="-ml-0.5">
                <a href="#" className="-m-1.5 block p-1.5">
                  <span className="sr-only">Your Company</span>
                  <img
                    className="h-8 w-auto"
                    src="/api/placeholder/32/32"
                    alt=""
                  />
                </a>
              </div>
            </div>
            <div className="mt-2 space-y-2">
              {navigation.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  className={classNames(
                    item.current
                      ? 'bg-gray-50 text-indigo-600'
                      : 'text-gray-700 hover:text-indigo-600',
                    'block rounded-lg py-2 pl-3 pr-4 text-base font-semibold leading-7'
                  )}
                >
                  {item.name}
                </a>
              ))}
            </div>
          </Dialog.Panel>
        </Dialog>

        {/* Background gradient */}
        <div
          aria-hidden="true"
          className="absolute left-0 top-full -z-10 mt-96 origin-top-left translate-y-40 -rotate-90 transform-gpu opacity-20 blur-3xl sm:left-1/2 sm:-ml-96 sm:-mt-10 sm:translate-y-0 sm:rotate-0 sm:transform-gpu sm:opacity-50"
        >
          <div
            className="aspect-[1154/678] w-[72.125rem] bg-gradient-to-br from-[#FF80B5] to-[#9089FC]"
            style={{
              clipPath:
                'polygon(100% 38.5%, 82.6% 100%, 60.2% 37.7%, 52.4% 32.1%, 47.5% 41.8%, 45.2% 65.6%, 27.5% 23.4%, 0.1% 35.3%, 17.9% 0%, 27.7% 23.4%, 76.2% 2.5%, 74.2% 56%, 100% 38.5%)',
            }}
          />
        </div>
      </main>
    </>
  );
}