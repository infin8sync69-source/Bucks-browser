import React, { useState } from 'react';
import { FaMagnifyingGlass, FaXmark } from 'react-icons/fa6';

interface SearchInputProps {
    initialQuery?: string;
    onSearch: (query: string) => void;
    placeholder?: string;
    className?: string;
}

const SearchInput: React.FC<SearchInputProps> = ({
    initialQuery = '',
    onSearch,
    placeholder = 'Search...',
    className = ''
}) => {
    const [query, setQuery] = useState(initialQuery);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSearch(query);
    };

    const clearSearch = () => {
        setQuery('');
        onSearch('');
    };

    return (
        <form onSubmit={handleSubmit} className={`relative flex items-center group ${className}`}>
            <div className="absolute left-6 text-white/20 group-focus-within:text-blue-500/60 transition-colors">
                <FaMagnifyingGlass className="text-lg" />
            </div>
            <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-transparent text-white/90 placeholder-white/10 text-lg py-5 pl-16 pr-14 outline-none font-light tracking-wide transition-all"
            />
            {query && (
                <button
                    type="button"
                    onClick={clearSearch}
                    className="absolute right-4 w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/20 hover:text-white/60 hover:bg-white/10 transition-all"
                >
                    <FaXmark />
                </button>
            )}
        </form>
    );
};

export default SearchInput;
