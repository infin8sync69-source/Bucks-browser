import React from 'react';
import ServiceCategoryPageClient from './ServiceCategoryPageClient';
import { FaTaxi, FaBriefcase, FaUtensils, FaBagShopping, FaWallet, FaTicket, FaTruckFast, FaUsers, FaBuildingColumns, FaNetworkWired } from 'react-icons/fa6';

const categoryConfig: Record<string, any> = {
    taxi: { icon: FaTaxi, label: 'Taxi', color: 'text-yellow-600', bg: 'bg-yellow-100' },
    jobs: { icon: FaBriefcase, label: 'Jobs', color: 'text-blue-600', bg: 'bg-blue-100' },
    foods: { icon: FaUtensils, label: 'Foods', color: 'text-orange-600', bg: 'bg-orange-100' },
    shopping: { icon: FaBagShopping, label: 'Shopping', color: 'text-pink-600', bg: 'bg-pink-100' },
    pay: { icon: FaWallet, label: 'Pay', color: 'text-purple-600', bg: 'bg-purple-100' },
    tickets: { icon: FaTicket, label: 'Book Tickets', color: 'text-green-600', bg: 'bg-green-100' },
    delivery: { icon: FaTruckFast, label: 'Delivery', color: 'text-red-600', bg: 'bg-red-100' },
    community: { icon: FaUsers, label: 'Community', color: 'text-teal-600', bg: 'bg-teal-100' },
    banking: { icon: FaBuildingColumns, label: 'Banking', color: 'text-indigo-600', bg: 'bg-indigo-100' },
    networks: { icon: FaNetworkWired, label: 'Networks', color: 'text-cyan-600', bg: 'bg-cyan-100' },
};

export function generateStaticParams() {
    return Object.keys(categoryConfig).map(category => ({
        category: category,
    }));
}

export default function ServiceCategoryPage() {
    return <ServiceCategoryPageClient />;
}
